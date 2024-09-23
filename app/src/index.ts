import express, { NextFunction, Request, Response } from 'express';
import { buildCommonFailureResponse, buildFailureResponse } from './utils/RspUtil';
import { BizError } from './types';
import axios from 'axios';
import { configDotenv } from 'dotenv';
import { Brevis, ErrCode, ProofRequest, Prover, TransactionData } from 'brevis-sdk-typescript';
import { ethers } from 'ethers';

const app = express();
configDotenv();
const port = 8081;

if(!(process.env.ENV_PROVER_URL && process.env.ENV_BREVIS_SERVICE_URL)){
    throw new Error('ENV_PROVER_URL and ENV_BREVIS_SERVICE_URL are required')
}
// @ts-ignore
const prover = new Prover(process.env.ENV_PROVER_URL);
// @ts-ignore
const brevis = new Brevis(process.env.ENV_BREVIS_SERVICE_URL);

app.use(express.static('static'));
app.use(express.json());

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});


//curl http://ip:port/brevis-network/transaction/proof?address=0x?????

app.get('/brevis-network/transaction/proof', (req: Request, res: Response, next: NextFunction) => {
    transactionProof(req, res, next);
});

app.use((req: Request, res: Response) => {
    res.status(404).send('404 Not Found');
});


app.use((err: BizError, req: Request, res: Response, next: Function) => {
    return res.status(200).set('Content-Type', 'application/json').send(buildFailureResponse(err));
});

app.use((err: Error, req: Request, res: Response, next: Function) => {
    return res.status(200).set('Content-Type', 'application/json').send(buildCommonFailureResponse());
});


// Create a map to store the auth requests and their session IDs
const requestMap = new Map();

// GetQR returns auth request
async function transactionProof(req: Request, res: Response, next: NextFunction) {
    let address = req.query.address as string;
    console.log(`Generate transaction proof for ${address}`);
    if (!address) {
        return next(new BizError('-10001', 'Address is required'));
    }
    //select transaction from dune
    const config = {
        headers: {
            'X-Dune-API-Key': process.env.ENV_DUNE_API_KEY,
            'Content-Type': 'application/json',
        },
    };
    const body = {
        'query_parameters': {
            wallet_address: address,
        },
    };
    let rsp;
    try {
        rsp = await axios.post(`https://api.dune.com/api/v1/query/4085976/execute`, body, config);
    } catch (err) {
        console.log(err);
        // @ts-ignore
        return next(new BizError('-10000', err.message));
    }
    //get query results
    let queryStatus;
    let transactionId;
    while (queryStatus !== 'QUERY_STATE_COMPLETED'){
        try {
            rsp = await axios.get(`https://api.dune.com/api/v1/execution/${rsp.data.execution_id}/results`, config);
            queryStatus = rsp.data.state;
            if(queryStatus === 'QUERY_STATE_COMPLETED'){
                if(rsp.data.result.metadata.row_count > 0){
                    transactionId = rsp.data.result.rows[0].hash;
                }else{
                    return next(new BizError('-10003', 'No transaction found'));
                }
                break;
            }
            if(queryStatus === 'QUERY_STATE_FAILED' || queryStatus ==='QUERY_STATE_CANCELLED'|| queryStatus==='QUERY_STATE_EXPIRED'||queryStatus === 'QUERY_STATE_COMPLETED_PARTIAL'){
                return next(new BizError('-10004', 'Query failed'));
            }
            //sleep 500 ms
            console.log(`Try request later after 500ms `)
            await new Promise(resolve => setTimeout(resolve, 500));

        } catch (err) {
            console.log(err);
            // @ts-ignore
            return next(new BizError('-10000', err.message));
        }
    }

    //start to handle brevis process
    console.log(`transactionId :${transactionId}`)
    const proofReq = new ProofRequest();

    const provider = new ethers.providers.JsonRpcProvider(process.env.ENV_BSC_RPC_URL);

    console.log(`Get transaction info for ${transactionId}`)
    const transaction = await provider.getTransaction(transactionId)
    if(!transaction){
        return next(new BizError('-10005', 'Transaction not found'))
    }

    // if (transaction.type != 0 && transaction.type != 2) {
    //     console.error("only type0 and type2 transactions are supported")
    //     return
    // }

    // if (transaction.nonce != 0) {
    //     console.error("only transaction with nonce 0 is supported by sample circuit")
    //     return
    // }

    const receipt = await provider.getTransactionReceipt(transactionId)
    var gas_tip_cap_or_gas_price = ''
    var gas_fee_cap = ''
    if (transaction.type = 0) {
        //todo
        gas_tip_cap_or_gas_price = transaction.gasPrice?._hex ?? '0x00'
        gas_fee_cap = '0x00'
    } else {
        gas_tip_cap_or_gas_price = transaction.maxPriorityFeePerGas?._hex ?? '0x00'
        gas_fee_cap = transaction.maxFeePerGas?._hex ?? '0x00'
    }

    proofReq.addTransaction(
        // @ts-ignore
        new TransactionData({
            hash: transactionId,
            chain_id: transaction.chainId,
            block_num: transaction.blockNumber,
            nonce: transaction.nonce,
            gas_tip_cap_or_gas_price: gas_tip_cap_or_gas_price,
            gas_fee_cap: gas_fee_cap,
            //todo
            gas_limit: transaction.gasLimit.toString(),
            from: transaction.from,
            to: transaction.to,
            value: transaction.value._hex,
        }),
    );

    console.log(`Send prove request for ${transactionId}`)

    const proofRes = await prover.prove(proofReq);
    // error handling
    if (proofRes.has_err) {
        const err = proofRes.err;
        switch (err.code) {
            case ErrCode.ERROR_INVALID_INPUT:
                console.error('invalid receipt/storage/transaction input:', err.msg);
                break;

            case ErrCode.ERROR_INVALID_CUSTOM_INPUT:
                console.error('invalid custom input:', err.msg);
                break;

            case ErrCode.ERROR_FAILED_TO_PROVE:
                console.error('failed to prove:', err.msg);
                break;
        }
        return;
    }
    console.log('proof', proofRes.proof);

    try {
        const brevisRes = await brevis.submit(proofReq, proofRes, 56, 97, 0, '', '');
        console.log('brevis res', brevisRes);

        await brevis.wait(brevisRes.queryKey, 97);
    } catch (err) {
        console.error(err);
    }

    return res.status(200).set('Content-Type', 'application/json').send({ success: true });
}



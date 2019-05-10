import { IBitcoinConfig } from './BitcoinConfig';
import TransactionNumber from './TransactionNumber';
import { ITransaction } from '../core/Transaction';
import SidetreeError from '../core/util/SidetreeError';
import MongoDbTransactionStore from '../core/MongoDbTransactionStore';
import nodeFetch, { Response, FetchError } from 'node-fetch';
import ReadableStreamUtils from '../core/util/ReadableStreamUtils';
import * as httpStatus from 'http-status';
import { PrivateKey, Networks, Transaction, Script, Address } from 'bitcore-lib';

/**
 * Object representing a blockchain time and hash
 */
export interface IBlockchainTime {
  /** The logical blockchain time */
  time: number;
  /** The hash associated with the blockchain time */
  hash: string;
}

/**
 * Processor for Bitcoin REST API calls
 */
export default class BitcoinProcessor {

  /** URI for the bitcoin peer's RPC endpoint */
  public readonly bitcoinExtensionUri: string;
  /** Prefix used to identify Sidetree transactions in Bitcoin's blockchain. */
  public readonly sidetreePrefix: string;
  /** Bitcoin transaction fee amount */
  public readonly bitcoinFee: number;
  /** The first Sidetree transaction number in Bitcoin's blockchain. */
  public readonly genesisTransactionNumber: number;
  /** The corresponding time hash of genesis transaction number. */
  public readonly genesisTimeHash: string;
  /** Store for the state of sidetree transactions. */
  private readonly transactionStore: MongoDbTransactionStore;

  /** Wallet private key */
  private readonly privateKey: PrivateKey;

  /** Number of items to return per page */
  public pageSize: number;

  /** request timeout in milliseconds */
  public defaultTimeout = 300;

  /** maximum number of request retries */
  public maxRetries = 3;

  public constructor (config: IBitcoinConfig) {
    this.bitcoinExtensionUri = config.bitcoinExtensionUri;
    this.sidetreePrefix = config.sidetreeTransactionPrefix;
    this.genesisTransactionNumber = TransactionNumber.construct(config.genesisBlockNumber, 0);
    this.genesisTimeHash = config.genesisBlockHash;
    this.transactionStore = new MongoDbTransactionStore(config.mongoDbConnectionString, config.databaseName);
    this.pageSize = config.maxSidetreeTransactions;
    /// Bitcore has a type file error on PrivateKey
    this.bitcoinFee = config.bitcoinFee;
    try {
      this.privateKey = (PrivateKey as any).fromWIF(config.bitcoinWalletImportString);
    } catch (error) {
      throw new SidetreeError(httpStatus.INTERNAL_SERVER_ERROR, 'bitcoinWalletImportString: ' + error.message);
    }
  }

  /**
   * generates a private key in WIF format
   * @param network Which bitcoin network to generate this key for
   */
  public static generatePrivateKey (network: 'mainnet' | 'livenet' | 'testnet' | undefined): string {
    let bitcoreNetwork: Networks.Network | undefined;
    switch (network) {
      case 'mainnet':
        bitcoreNetwork = Networks.mainnet;
        break;
      case 'livenet':
        bitcoreNetwork = Networks.livenet;
        break;
      case 'testnet':
        bitcoreNetwork = Networks.testnet;
        break;
    }
    return new PrivateKey(undefined, bitcoreNetwork).toWIF();
  }

  /**
   * Initializes the Bitcoin processor
   */
  public async initialize () {
    console.debug('Initializing TransactionStore');
    await this.transactionStore.initialize();
    const lastKnownTransaction = await this.transactionStore.getLastTransaction();
    let startSyncBlockHeight = lastKnownTransaction ? lastKnownTransaction.transactionTime : TransactionNumber.getBlockNumber(this.genesisTransactionNumber);
    let startSyncBlockHash = lastKnownTransaction ? lastKnownTransaction.transactionTimeHash : this.genesisTimeHash;
    console.info(`Last known block ${startSyncBlockHeight} (${startSyncBlockHash})`);
    await this.processTransactions(startSyncBlockHeight, startSyncBlockHash);
  }

  /**
   * Gets the latest logical blockchain time.
   * @param hash time blockchain time hash
   * @returns the current or associated blockchain time and blockchain hash
   */
  public async time (hash?: string): Promise<IBlockchainTime> {
    console.info(`Getting time ${hash ? 'since' + hash : ''}`);
    let request: any;
    if (hash) {
      request = {
        method: 'getblock',
        params: [
          hash, // hash of the block
          true, // block details
          false // transaction details
        ]
      };

    } else {
      const tip = await this.getTip();
      request = {
        method: 'getblockbyheight',
        params: [
          tip,  // height of the block
          true, // block details
          false // transaction details
        ]
      };
    }
    const response = await this.bcoinFetch(request);
    return {
      hash: response.hash,
      time: response.height
    };
  }

  /**
   * Fetches Sidetree transactions in chronological order from since or genesis.
   * @param since A transaction number
   * @param hash The associated transaction time hash
   * @returns Transactions since that blocktime
   */
  public async transactions (since?: number, hash?: string): Promise<{
    moreTransactions: boolean,
    transactions: ITransaction[]
  }> {
    if (since && !hash) {
      throw new SidetreeError(httpStatus.BAD_REQUEST);
    }
    if (!since || !hash) {
      since = this.genesisTransactionNumber;
      hash = this.genesisTimeHash;
    }
    console.info(`Returning transactions since ${TransactionNumber.getBlockNumber(since)}`);

    if (!await this.verifyBlock(TransactionNumber.getBlockNumber(since), hash)) {
      console.info('Requested transaction hash mismatched blockchain');
      throw new SidetreeError(httpStatus.BAD_REQUEST);
    }

    const transactions = await this.transactionStore.getTransactionsLaterThan(since, this.pageSize);

    return {
      transactions,
      moreTransactions: transactions.length === this.pageSize
    };
  }

  /**
   * Given a list of Sidetree transactions, returns the first transaction in the list that is valid.
   * @param transactions List of transactions to check
   * @returns The first valid transaction, or undefined if none are valid
   */
  public async firstValidTransaction (transactions: ITransaction[]): Promise<ITransaction | undefined> {
    // sort so lower transaction numbers come first
    const sortedTransactions = transactions.sort((aTransaction, bTransaction) => {
      // <0  a comes before b
      // >0  b comes before a
      return aTransaction.transactionNumber - bTransaction.transactionNumber;
    });

    for (let index = sortedTransactions.length - 1; index >= 0; index--) {
      const transaction = sortedTransactions[index];
      const height = transaction.transactionTime;
      const hash = transaction.transactionTimeHash;
      if (await this.verifyBlock(height, hash)) {
        return transaction;
      }
    }
    return;
  }

  /**
   * Writes a Sidetree transaction to the underlying Bitcoin's blockchain.
   * @param anchorFileHash The hash of a Sidetree anchor file
   */
  public async writeTransaction (anchorFileHash: string) {
    console.info(`Anchoring file ${anchorFileHash}`);
    const sidetreeTransactionString = `${this.sidetreePrefix}${anchorFileHash}`;

    const address = this.privateKey.toAddress();
    const unspentOutputs = await this.getUnspentCoins(address);

    if (unspentOutputs.length === 0) {
      console.error('FUND WALLET');
      throw new SidetreeError(httpStatus.INTERNAL_SERVER_ERROR);
    }

    const transaction = new Transaction();
    transaction.from(unspentOutputs);
    transaction.addOutput(new Transaction.Output({
      script: Script.buildDataOut(sidetreeTransactionString),
      satoshis: 0
    }));
    transaction.change(address);
    transaction.fee(this.bitcoinFee);
    transaction.sign(this.privateKey);

    if (!await this.broadcastTransaction(transaction)) {
      console.error(`Could not broadcast transaction ${transaction.toString()}`);
      throw new SidetreeError(httpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * Gets all unspent coins of a given address
   * @param address Bitcoin address to get coins for
   */
  private async getUnspentCoins (address: Address): Promise<Transaction.UnspentOutput[]> {
    const addressToSearch = address.toString();
    const path = `/coin/address/${addressToSearch}`;
    const fullPath = path.concat(this.bitcoinExtensionUri, path);
    const response = await this.fetchWithRetry(fullPath);

    const responseData = await ReadableStreamUtils.readAll(response.body);
    if (response.status !== httpStatus.OK) {
      const error = new SidetreeError(response.status, responseData);
      console.error(`Fetch failed [${response.status}]: ${responseData}`);
      throw error;
    }

    const responseJson = JSON.parse(responseData) as Array<any>;
    const unspentTransactions = responseJson.map((coin) => {
      return new Transaction.UnspentOutput({
        txid: coin.hash,
        vout: coin.index,
        address: coin.address,
        script: coin.script,
        amount: coin.value
      });
    });
    return unspentTransactions;
  }

  /**
   * Broadcasts a transaction to the bitcoin network
   * @param transaction Transaction to broadcast
   */
  private async broadcastTransaction (transaction: Transaction): Promise<boolean> {
    console.info('Boradcasting transaction');
    const rawTransaction = transaction.serialize();

    const response = await this.bcoinFetch({
      tx: rawTransaction
    }, '/broadcast');

    return response.success;
  }

  /**
   * Processes transactions from startBlock to endBlock or tip
   * @param startBlock The block height to begin from
   * @param startBlockHash The block hash to begin from
   * @param endBlock The blockheight to stop on (inclusive)
   */
  private async processTransactions (startBlock: number, startBlockHash: string, endBlock?: number) {
    const startValid = await this.verifyBlock(startBlock, startBlockHash);
    let beginBlock = startBlock;
    if (!startValid) {
      beginBlock = await this.revertBlockchainCache();
    }
    if (endBlock === undefined) {
      endBlock = await this.getTip();
    }

    console.info(`Processing transactions from ${startBlock} to ${endBlock}`);

    // You can parrallelize this so long as all processBlock's don't throw
    for (let blockHeight = beginBlock; blockHeight < endBlock; blockHeight++) {
      await this.processBlock(blockHeight);
    }
  }

  /**
   * Begins to revert the blockchain cache until consistent, returns last good height
   * @returns last valid block height before the fork
   */
  private async revertBlockchainCache (): Promise<number> {
    console.info('Reverting transactions');
    while (await this.transactionStore.getTransactionsCount() > 0) {
      const exponentiallySpacedTransactions = await this.transactionStore.getExponentiallySpacedTransactions();

      const firstValidTransaction = await this.firstValidTransaction(exponentiallySpacedTransactions);

      let revertToTransactionNumber: number;

      if (firstValidTransaction) {
        revertToTransactionNumber = firstValidTransaction.transactionNumber;
      } else {
        const lowestHeight = exponentiallySpacedTransactions.reduce((height: number, transaction: ITransaction): number => {
          return height < transaction.transactionTime ? height : transaction.transactionTime;
        }, exponentiallySpacedTransactions[0].transactionTime);
        revertToTransactionNumber = TransactionNumber.construct(lowestHeight, 0);
      }

      console.debug(`Removing transactions since ${TransactionNumber.getBlockNumber(revertToTransactionNumber)}`);
      await this.transactionStore.removeTransactionsLaterThan(revertToTransactionNumber);

      if (firstValidTransaction) {
        console.info(`reverted Transactions to block ${firstValidTransaction.transactionTime}`);
        return firstValidTransaction.transactionTime;
      }
    }
    // there are no transactions stored.
    console.info('Reverted all known transactions.');
    return TransactionNumber.getBlockNumber(this.genesisTransactionNumber);
  }

  /**
   * Gets the current Bitcoin tip height
   * @returns the latest block number
   */
  private async getTip (): Promise<number> {
    console.info('Getting tip block');
    const request = {
      method: 'getblockcount'
    };
    const response = await this.bcoinFetch(request);
    return response;
  }

  /**
   * Given a Bitcoin block height and hash, verifies against the blockchain
   * @param height Block height to verify
   * @param hash Block hash to verify
   * @returns true if valid, false otherwise
   */
  private async verifyBlock (height: number, hash: string): Promise<boolean> {
    console.info(`Verifying block ${height} (${hash})`);
    const responseData = await this.bcoinFetch({
      method: 'getblockbyheight',
      params: [
        height,  // height
        true,   // verbose (block details)
        false    // details (transaction details)
      ]
    });

    console.debug(`Retrieved block ${responseData.height} (${responseData.hash})`);

    let actualHash: string = responseData.hash;
    return hash === actualHash;
  }

  /**
   * Given a Bitcoin block height, processes that block for Sidetree transactions
   * @param block Block height to process
   */
  private async processBlock (block: number) {
    console.info(`Processing block ${block}`);
    const responseData = await this.bcoinFetch({
      method: 'getblockbyheight',
      params: [
        block,  // height
        true,   // verbose (block details)
        true    // details (transaction details)
      ]
    });

    const transactions = responseData.tx as Array<any>;
    const blockHash = responseData.hash;
    let anchorFilePosition = 0;

    // console.debug(`Block ${block} contains ${transactions.length} transactions`);

    // iterate through transactions
    for (let transactionIndex = 0; transactionIndex < transactions.length; transactionIndex++) {
      // get the output coins in the transaction
      if (!('vout' in transactions[transactionIndex])) {
        // console.debug(`Skipping transaction ${transactionIndex}: no output coins.`);
        continue;
      }
      const outputs = transactions[transactionIndex].vout as Array<any>;
      for (let outputIndex = 0; outputIndex < outputs.length; outputIndex++) {
        // grab the scripts
        const script = outputs[outputIndex].scriptPubKey;

        // console.debug(`Checking transaction ${transactionIndex} output coin ${outputIndex}: ${JSON.stringify(script)}`);
        // check for returned data for sidetree prefix
        const hexDataMatches = script.asm.match(/\s*OP_RETURN ([0-9a-fA-F]+)$/);
        if (!hexDataMatches || hexDataMatches.length === 0) {
          continue;
        }
        const data = Buffer.from(hexDataMatches[1], 'hex').toString();
        if (data.startsWith(this.sidetreePrefix)) {
          // we have found a sidetree transaction
          const sidetreeTransaction: ITransaction = {
            transactionNumber: TransactionNumber.construct(block, anchorFilePosition),
            transactionTime: block,
            transactionTimeHash: blockHash,
            anchorFileHash: data.slice(this.sidetreePrefix.length)
          };
          console.debug(`Sidetree transaction found; adding ${JSON.stringify(sidetreeTransaction)}`);
          anchorFilePosition++;
          await this.transactionStore.addTransaction(sidetreeTransaction);
        }
      }
    }
  }

  /**
   * performs an RPC call given a request
   * @param request RPC request parameters as an object
   * @param path optional path extension
   * @returns response as an object
   */
  private async bcoinFetch (request: any, path: string = ''): Promise<any> {
    const fullPath = path.concat(this.bitcoinExtensionUri, path);
    const requestString = JSON.stringify(request);
    // console.debug(`Fetching ${fullPath}`);
    // console.debug(requestString);
    const response = await this.fetchWithRetry(fullPath, {
      body: requestString,
      method: 'post'
    });

    const responseData = await ReadableStreamUtils.readAll(response.body);
    if (response.status !== httpStatus.OK) {
      const error = new SidetreeError(response.status, responseData);
      console.error(`Fetch failed [${response.status}]: ${responseData}`);
      throw error;
    }

    const responseJson = JSON.parse(responseData);

    if ('error' in responseJson && responseJson.error !== null) {
      console.error(`RPC failed: ${JSON.stringify(responseJson.error)}`);
      throw new SidetreeError(httpStatus.INTERNAL_SERVER_ERROR);
    }

    return responseJson.result;
  }

  /**
   * Calls node Fetch and retries the request on temporal errors
   * @param uri URI to fetch
   * @param requestParameters GET parameters to use
   * @returns Response of the fetch
   */
  private async fetchWithRetry (uri: string, requestParameters?: RequestInit | undefined): Promise<Response> {
    let retryCount = 0;
    let timeout: number;
    do {
      timeout = this.defaultTimeout * 2 ** retryCount;
      const params = Object.assign({}, requestParameters, {
        timeout
      });
      try {
        return await nodeFetch(uri, params);
      } catch (error) {
        if (error instanceof FetchError) {
          retryCount++;
          if (retryCount >= this.maxRetries) {
            console.debug('Max retries reached. Request failed.');
            throw error;
          }
          switch (error.type) {
            case 'request-timeout':
              console.debug(`Request timeout (${retryCount})`);
              await this.waitFor(Math.round(Math.random() * this.defaultTimeout + timeout));
              console.debug('Retrying request');
              continue;
          }
        }
        console.error(error);
        throw error;
      }
    } while (true);
  }

  /**
   * Async timeout
   * @param milliseconds Timeout in milliseconds
   */
  private async waitFor (milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    });
  }

}
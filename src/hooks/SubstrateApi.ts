import { ApiPromise, WsProvider } from "@polkadot/api";
import { Option, Struct, TypeRegistry } from "@polkadot/types";
import type {
  DispatchError,
  MultiAsset,
  MultiLocation,
  VersionedXcm,
} from "@polkadot/types/interfaces";
import type { ISubmittableResult, ITuple } from "@polkadot/types/types";
import { decodeAddress } from "@polkadot/util-crypto";
import BN from "bn.js";
import type { SubmittableExtrinsic } from "@polkadot/api/types";

export type ExtrinsicPayload = SubmittableExtrinsic<"promise">;
const idAstarNativeToken = "000000000000000000000";

const AUTO_CONNECT_MS = 10_000; // [ms]

interface ChainProperty {
  tokenSymbols: string[];
  tokenDecimals: number[];
  chainName: string;
  ss58Prefix: number;
}

interface AssetConfig extends Struct {
  v1: {
    parents: number;
    interior: Interior;
  };
}

interface Interior {
  x2: X2[];
}

interface X2 {
  parachain: number;
  generalKey: string;
}

class ChainApi {
  private _provider?: WsProvider;
  private _api: ApiPromise;
  private _chainProperty: ChainProperty | undefined;
  private _registry: TypeRegistry;

  constructor(api: ApiPromise | null, endpoint?: string) {
    if (api) {
      this._api = api;
    } else {
      this._provider = new WsProvider(endpoint, AUTO_CONNECT_MS);

      console.info("connecting to " + endpoint);
      this._api = new ApiPromise({
        provider: this._provider,
      });
    }

    this._registry = new TypeRegistry();
  }

  public get apiInst() {
    if (!this._api) {
      throw new Error("The ApiPromise has not been initialized");
    }
    return this._api;
  }

  public get chainProperty() {
    return this._chainProperty;
  }

  public get typeRegistry() {
    return this._registry;
  }

  public async start() {
    this._api = await this._api.isReady;

    const chainProperties = await this._api.rpc.system.properties();

    const ss58Prefix = parseInt(
      (await this._api.consts.system.ss58Prefix).toString() || "0"
    );

    const tokenDecimals = chainProperties.tokenDecimals
      .unwrapOrDefault()
      .toArray()
      .map((i) => i.toNumber());

    const tokenSymbols = chainProperties.tokenSymbol
      .unwrapOrDefault()
      .toArray()
      .map((i) => i.toString());

    const chainName = (await this._api.rpc.system.chain()).toString();

    this._chainProperty = {
      tokenSymbols,
      tokenDecimals,
      chainName,
      ss58Prefix,
    };
  }

  public buildTxCall(
    extrinsic: string,
    method: string,
    ...args: any[]
  ): ExtrinsicPayload {
    const ext = this._api?.tx[extrinsic][method](...args);
    if (ext) return ext;
    throw `Undefined extrinsic call ${extrinsic} with method ${method}`;
  }

  public async isReady(): Promise<void> {
    try {
      await this._api?.isReady;
    } catch (e) {
      console.error(e);
    }
  }

  public async signAndSend({
    account,
    signer,
    tx,
    finalizedCallback,
    handleResult,
    tip,
  }: {
    account: string;
    signer: any;
    tx: ExtrinsicPayload;
    finalizedCallback: () => void;
    handleResult?: (result: ISubmittableResult) => Promise<boolean>;
    tip: string;
  }) {
    return new Promise<boolean>(async (resolve) => {
      const txsToExecute: ExtrinsicPayload[] = [];
      txsToExecute.push(tx);
      const transaction = this._api.tx.utility.batch(txsToExecute);
      try {
        // ensure that we automatically increment the nonce per transaction
        await transaction.signAndSend(
          account,
          { signer, nonce: -1, tip },
          (result) => {
            const status = result.status;
            if (status.isFinalized) {
              let finalResult = false;
              const events = result.events;
              events
                .filter(
                  (record): boolean =>
                    !!record.event && record.event.section !== "democracy"
                )
                .map(({ event: { data, method, section } }) => {
                  // console.log('event', method, section, data);
                  // if (section === 'utility' && method === 'BatchInterrupted') {
                  //   console.log(data.toHuman());
                  // }

                  if (section === "system" && method === "ExtrinsicFailed") {
                    const [dispatchError] = data as unknown as ITuple<
                      [DispatchError]
                    >;
                    let message = dispatchError.type.toString();

                    if (dispatchError.isModule) {
                      try {
                        const mod = dispatchError.asModule;
                        const error = dispatchError.registry.findMetaError(mod);

                        message = `${error.section}.${error.name}`;
                      } catch (error) {
                        // swallow
                        console.error(error);
                      }
                    } else if (dispatchError.isToken) {
                      message = `${dispatchError.type}.${dispatchError.asToken.type}`;
                    }

                    console.log(`action: ${section}.${method} ${message}`);
                    finalResult = true;
                  } else if (
                    section === "utility" &&
                    method === "BatchInterrupted"
                  ) {
                    // TODO there should be a better way to extract error,
                    // for some reason cast data as unknown as ITuple<[DispatchError]>; doesn't work
                    const anyData = data as any;
                    const error = anyData[1].registry.findMetaError(
                      anyData[1].asModule
                    );
                    let message = `${error.section}.${error.name}`;
                    console.log(`action: ${section}.${method} ${message}`);
                    finalResult = true;
                  }
                });

              if (!finalResult) resolve(true);
              finalizedCallback();
            }

            // handleResult &&
            //   handleResult(result).then(async () => {
            //     await finalizedCallback();
            //     resolve(true);
            //   });

            // handle transaction errors
            result.events
              .filter(
                (record): boolean =>
                  !!record.event && record.event.section !== "democracy"
              )
              .map(async ({ event: { data, method, section } }) => {
                if (section === "system" && method === "ExtrinsicFailed") {
                  const [dispatchError] = data as unknown as ITuple<
                    [DispatchError]
                  >;
                  let message = dispatchError.type.toString();

                  if (dispatchError.isModule) {
                    try {
                      const mod = dispatchError.asModule;
                      const error = dispatchError.registry.findMetaError(mod);

                      message = `${error.section}.${error.name}`;
                      resolve(false);
                    } catch (error) {
                      console.error(error);
                      resolve(false);
                    }
                  } else if (dispatchError.isToken) {
                    message = `${dispatchError.type}.${dispatchError.asToken.type}`;
                  }

                  const errorMessage = `${section}.${method} ${message}`;
                  console.error(`error: ${errorMessage}`);
                  throw new Error(message);
                } else if (
                  section === "utility" &&
                  method === "BatchInterrupted"
                ) {
                  const anyData = data as any;
                  const error = anyData[1].registry.findMetaError(
                    anyData[1].asModule
                  );
                  let message = `${error.section}.${error.name}`;
                  console.error(`error: ${section}.${method} ${message}`);
                  resolve(false);
                }
              });
          }
        );
      } catch (error) {
        console.error(error);
        resolve(false);
      }
    });
  }
}

export class RelaychainApi extends ChainApi {
  constructor(endpoint: string) {
    super(null, endpoint);
  }
  override async start() {
    await super.start();

    // const parachains = (await this.buildStorageQuery('paras', 'parachains')) as Vec<u32>;
    // this._parachains = parachains.map((i) => i.toNumber());
    // check if the connected network implements xcmPallet
  }

  public transferToParachain({
    toPara,
    recipientAccountId,
    amount,
  }: {
    toPara: number;
    recipientAccountId: string;
    amount: string;
  }) {
    // public transferToParachain(toPara: number, recipientAccountId: string, amount: string) {
    // the target parachain connected to the current relaychain
    const dest = {
      V1: {
        interior: {
          X1: {
            Parachain: new BN(toPara),
          },
        },
        parents: new BN(0),
      },
    };
    // the account ID within the destination parachain
    const beneficiary = {
      V1: {
        interior: {
          X1: {
            AccountId32: {
              network: "Any",
              id: decodeAddress(recipientAccountId),
            },
          },
        },
        parents: new BN(0),
      },
    };
    // amount of fungible tokens to be transferred
    const assets = {
      V1: [
        {
          fun: {
            Fungible: new BN(amount),
          },
          id: {
            Concrete: {
              interior: "Here",
              parents: new BN(0),
            },
          },
        },
      ],
    };

    return this.buildTxCall(
      "xcmPallet",
      "reserveTransferAssets",
      dest,
      beneficiary,
      assets,
      new BN(0)
    );
  }

  public xcmReserveTransferAsset(
    dest: MultiLocation,
    beneficiary: MultiLocation,
    assets: MultiAsset,
    feeAssetItem: BN
  ) {
    return this.buildTxCall(
      "xcmPallet",
      "reserveTransferAssets",
      dest,
      beneficiary,
      assets,
      feeAssetItem
    );
  }

  public xcmExecute(message: VersionedXcm, maxWeight: BN) {
    return this.buildTxCall("xcmPallet", "execute", message, maxWeight);
  }

  public xcmSend(dest: MultiLocation, message: VersionedXcm) {
    return this.buildTxCall("xcmPallet", "send", dest, message);
  }
}

export class ParachainApi extends ChainApi {
  constructor(api: ApiPromise) {
    super(api);
  }

  public async fetchAssetConfig(assetId: string): Promise<{
    parents: number;
    interior: Interior;
  }> {
    const config = await this.apiInst.query.xcAssetConfig.assetIdToLocation<
      Option<AssetConfig>
    >(assetId);
    const formattedAssetConfig = JSON.parse(config.toString());
    return formattedAssetConfig.v1;
  }

  public async transferToOriginChain({
    assetId,
    recipientAccountId,
    amount,
    isNativeToken,
    paraId,
  }: {
    assetId: string;
    recipientAccountId: string;
    amount: string;
    isNativeToken: boolean;
    paraId: number;
  }): Promise<ExtrinsicPayload> {
    const isWithdrawAssets = assetId !== idAstarNativeToken;
    const functionName = isWithdrawAssets
      ? "reserveWithdrawAssets"
      : "reserveTransferAssets";
    const isSendToParachain = paraId > 0;
    const dest = isSendToParachain
      ? {
          V1: {
            interior: {
              X1: {
                Parachain: new BN(paraId),
              },
            },
            parents: new BN(1),
          },
        }
      : {
          V1: {
            interior: "Here",
            parents: new BN(1),
          },
        };

    const beneficiary = {
      V1: {
        interior: {
          X1: {
            AccountId32: {
              network: "Any",
              id: decodeAddress(recipientAccountId),
            },
          },
        },
        parents: new BN(0),
      },
    };

    const isRegisteredAsset = isSendToParachain && isWithdrawAssets;

    const asset = isRegisteredAsset
      ? {
          Concrete: await this.fetchAssetConfig(assetId),
        }
      : {
          Concrete: {
            interior: "Here",
            parents: new BN(isSendToParachain ? 0 : 1),
          },
        };

    const assets = {
      V1: [
        {
          fun: {
            Fungible: new BN(amount),
          },
          id: asset,
        },
      ],
    };

    return this.buildTxCall(
      "polkadotXcm",
      functionName,
      dest,
      beneficiary,
      assets,
      new BN(0)
    );
  }
}

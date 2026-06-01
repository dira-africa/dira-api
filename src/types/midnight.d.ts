/*
 * Copyright 2026 Blockchain & Climate Institute
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

declare module "@midnight-ntwrk/midnight-js" {
  export interface ProofProvider {
    proofServerUrl: string;
  }
  export interface IndexerPublicDataProvider {
    indexerUrl: string;
  }
  export interface WalletProvider {
    walletSeed: string;
  }
  
  export interface DeployedContract<C> {
    deployTxData: {
      contractAddress: string;
    };
    callTx: Record<string, (...args: any[]) => Promise<{ txHash: string }>>;
  }

  export function deployContract<C>(
    providers: {
      proofProvider: ProofProvider;
      indexerPublicDataProvider: IndexerPublicDataProvider;
      walletProvider: WalletProvider;
    },
    options: {
      compiledContract: C;
      privateStateId: string;
      initialPrivateState?: any;
    }
  ): Promise<DeployedContract<C>>;

  export function findDeployedContract<C>(
    providers: {
      proofProvider: ProofProvider;
      indexerPublicDataProvider: IndexerPublicDataProvider;
      walletProvider: WalletProvider;
    },
    options: {
      compiledContract: C;
      contractAddress: string;
      privateStateId: string;
    }
  ): Promise<DeployedContract<C>>;
}

import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { createViemGateway, type EmberChainGateway } from './viem-ember-gateway';

export const EMBER_GATEWAY = Symbol('EMBER_GATEWAY');
export type { EmberChainGateway };

/** Factory producing the viem gateway for the configured deployment, or null when disabled. */
export function createEmberGatewayFromConfig(config: AppConfig): EmberChainGateway | null {
  if (!config.blockchain.enabled) return null;
  return createViemGateway({
    deployment: {
      network: config.blockchain.network,
      chainId: config.blockchain.chainId,
      rpcUrl: config.blockchain.rpcUrl,
      tokenAddress: config.blockchain.tokenAddress,
      treasuryAddress: config.blockchain.treasuryAddress,
      maxSupplyWhole: config.blockchain.maxSupplyWhole,
      deploymentBlock: config.blockchain.deploymentBlock,
      confirmations: config.blockchain.confirmations,
    },
    minter: config.blockchain.minterPrivateKeyFile
      ? { kind: 'keyFile', path: config.blockchain.minterPrivateKeyFile }
      : null,
    treasuryBurner: config.blockchain.treasurySignerPrivateKeyFile
      ? { kind: 'keyFile', path: config.blockchain.treasurySignerPrivateKeyFile }
      : null,
  });
}

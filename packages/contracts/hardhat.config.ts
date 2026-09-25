import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config({ path: "../../.env" });

const OPERATOR_KEY = process.env.HEDERA_OPERATOR_KEY ?? "";
const TESTNET_RPC_URL = process.env.HEDERA_TESTNET_RPC_URL ?? "https://testnet.hashio.io/api";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 }
    }
  },
  networks: {
    "hedera-testnet": {
      url: TESTNET_RPC_URL,
      accounts: OPERATOR_KEY ? [OPERATOR_KEY] : [],
      chainId: 296
    }
  }
};

export default config;

import { Client, PrivateKey, TopicCreateTransaction } from "@hashgraph/sdk";

/**
 * One-time setup: creates the HCS topic that rebalance proposals get published to, replacing
 * the manual copy/paste blob as the *primary* way owners share a pending proposal (the paste box
 * stays as a fallback — see README's "Proposal relay via HCS" section for why).
 *
 * This is the one script in this repo that uses the native Hedera SDK instead of Hardhat/ethers
 * — topic creation has no EVM/JSON-RPC equivalent, so there's no way to do this through the
 * Solidity/Hardhat side at all.
 *
 * Requires HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY from .env (the same operator account used
 * everywhere else in this repo — no separate credential needed just for this).
 */
async function main() {
  const operatorId = process.env.HEDERA_OPERATOR_ID;
  const operatorKey = process.env.HEDERA_OPERATOR_KEY;
  if (!operatorId || !operatorKey) {
    throw new Error("Set HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY in .env");
  }

  const client = Client.forTestnet().setOperator(operatorId, PrivateKey.fromStringECDSA(operatorKey));

  console.log("Creating HCS topic for rebalance proposals...");
  const tx = await new TopicCreateTransaction()
    .setTopicMemo("hedera-safe-swap: RebalanceModule proposal relay")
    .execute(client);

  const receipt = await tx.getReceipt(client);
  const topicId = receipt.topicId;
  if (!topicId) {
    throw new Error("Topic creation succeeded but no topicId was returned");
  }

  console.log(`Topic created: ${topicId.toString()}`);
  console.log(`Transaction: ${tx.transactionId.toString()}`);
  console.log(`\nHashscan link:`);
  console.log(`https://hashscan.io/testnet/topic/${topicId.toString()}`);

  console.log("\nCopy this into .env:");
  console.log(`NEXT_PUBLIC_PROPOSALS_TOPIC_ID=${topicId.toString()}`);

  client.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

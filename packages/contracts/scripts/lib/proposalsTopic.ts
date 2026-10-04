import { Client, PrivateKey, TopicCreateTransaction } from "@hashgraph/sdk";

/** Creates an open HCS topic (no submit key) for relaying Safe proposals between owners. Native
 * Hedera SDK, not ethers — topic creation has no EVM/JSON-RPC equivalent. */
export async function createProposalsTopic(operatorId: string, operatorKey: string, memo: string): Promise<string> {
  const client = Client.forTestnet().setOperator(operatorId, PrivateKey.fromStringECDSA(operatorKey));
  try {
    const tx = await new TopicCreateTransaction().setTopicMemo(memo).execute(client);
    const topicId = (await tx.getReceipt(client)).topicId;
    if (!topicId) throw new Error("Topic creation succeeded but no topicId was returned");
    return topicId.toString();
  } finally {
    client.close();
  }
}

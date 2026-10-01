import { NextResponse } from "next/server";
import { Client, PrivateKey, TopicMessageSubmitTransaction } from "@hashgraph/sdk";

/**
 * Publishes a rebalance proposal blob to the HCS topic (see create-proposals-topic.ts), so the
 * other owners can see it on the mirror node instead of waiting for it to be copy/pasted to them
 * — see README's "Proposal relay via HCS" section for the full picture, including why this one
 * piece needs a server at all when the rest of this app doesn't.
 *
 * This is the one place in the app that holds a private key server-side (the existing testnet
 * operator's — HEDERA_OPERATOR_ID/HEDERA_OPERATOR_KEY, never exposed as NEXT_PUBLIC_*). It only
 * ever uses that key to post data to an open topic; it never touches the Safe, the module, or
 * any owner's funds — the actual authorization to execute a rebalance still happens entirely
 * on-chain via approveHash()/execTransaction(), unaffected by whether this relay is up or not.
 */
export const runtime = "nodejs";

const MAX_BLOB_LENGTH = 4000; // proposals are a few hundred bytes; this is a generous ceiling

export async function POST(request: Request) {
  const topicId = process.env.NEXT_PUBLIC_PROPOSALS_TOPIC_ID;
  const operatorId = process.env.HEDERA_OPERATOR_ID;
  const operatorKey = process.env.HEDERA_OPERATOR_KEY;
  if (!topicId || !operatorId || !operatorKey) {
    return NextResponse.json({ error: "Proposal relay is not configured on this deployment." }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const blob = (body as { blob?: unknown })?.blob;
  if (typeof blob !== "string" || blob.length === 0 || blob.length > MAX_BLOB_LENGTH) {
    return NextResponse.json({ error: "Missing or oversized `blob`." }, { status: 400 });
  }

  const client = Client.forTestnet().setOperator(operatorId, PrivateKey.fromStringECDSA(operatorKey));
  try {
    const tx = await new TopicMessageSubmitTransaction({ topicId, message: blob }).execute(client);
    const receipt = await tx.getReceipt(client);
    return NextResponse.json({
      sequenceNumber: receipt.topicSequenceNumber?.toString(),
      transactionId: tx.transactionId.toString()
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 502 });
  } finally {
    client.close();
  }
}

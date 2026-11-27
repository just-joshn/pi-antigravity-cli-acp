import type { AnyMessage } from "@agentclientprotocol/sdk/unstable";

import { AcpClient } from "../../src/client.ts";
import type { SessionHooks, TurnEvent } from "../../src/session.ts";
import { type FakeAgentOptions, serveAgent } from "./fake-agent.ts";

export const identity = { name: "pi", title: "Pi", version: "9.9.9" };

/** Hooks for a session nobody answers: permissions and questions are left undecided. */
export const quietHooks: SessionHooks = {
	askPermission: () => Promise.resolve(undefined),
	elicit: () => Promise.resolve({ action: "cancel" }),
	changed: () => {},
};

export const initialSession = {
	options: [],
	tier: undefined,
	variants: [],
	cwd: "/work",
	directories: [],
	turns: 0,
};

export async function collect(turn: { next(): Promise<TurnEvent> }): Promise<readonly TurnEvent[]> {
	const events: TurnEvent[] = [];
	for (;;) {
		const event = await turn.next();
		events.push(event);
		if (event.type === "end" || event.type === "failed") return events;
	}
}

export function pair() {
	const toAgent = new TransformStream<AnyMessage, AnyMessage>();
	const toClient = new TransformStream<AnyMessage, AnyMessage>();
	return {
		agentSide: { readable: toAgent.readable, writable: toClient.writable },
		clientSide: { readable: toClient.readable, writable: toAgent.writable },
	};
}

export async function connect(options: FakeAgentOptions, hooks: Partial<SessionHooks> = {}) {
	const { agentSide, clientSide } = pair();
	const fake = serveAgent(agentSide, options);
	const client = await AcpClient.connect(clientSide, identity, { ...quietHooks, ...hooks });
	return {
		client,
		log: fake.log,
		close: () => {
			client.close();
			fake.close();
		},
	};
}

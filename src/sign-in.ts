import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import type { AcpClient, SignInMethod } from "./client.ts";
import { uniqueLabels } from "./labels.ts";
import { pick } from "./pick.ts";

export async function signIn(
	client: Pick<AcpClient, "signInMethods" | "signIn">,
	pane: { hasUI: boolean; ui: Pick<ExtensionUIContext, "select"> } | undefined,
	title: string,
): Promise<SignInMethod | undefined> {
	const methods = client.signInMethods;
	if (!pane?.hasUI || methods.length === 0) return undefined;
	const labels = methods.map((method) =>
		method.description ? `${method.name} — ${method.description}` : method.name,
	);
	const shown = uniqueLabels(labels, (label, n) => `${label} (${n})`);
	const method = await pick(pane.ui, title, methods, shown);
	if (method) await client.signIn(method.id);
	return method;
}

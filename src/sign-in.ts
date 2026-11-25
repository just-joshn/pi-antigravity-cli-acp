import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AcpClient, SignInMethod } from "./client.ts";

/** Asks the user how to sign in and has the agent do it. Undefined when nobody chose a method. */
export async function signIn(
  client: AcpClient,
  pane: ExtensionContext | undefined,
  title: string,
): Promise<SignInMethod | undefined> {
  const methods = client.signInMethods;
  if (!pane?.hasUI || methods.length === 0) return undefined;
  const labels = methods.map((method) =>
    method.description ? `${method.name} — ${method.description}` : method.name,
  );
  const picked = await pane.ui.select(title, labels);
  const method = picked === undefined ? undefined : methods[labels.indexOf(picked)];
  if (method) await client.signIn(method.id);
  return method;
}

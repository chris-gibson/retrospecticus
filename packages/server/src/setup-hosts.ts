import type { NetworkInterfaceInfo } from "node:os";

const PLACEHOLDER = "<this server's address>";

export interface SetupHostInputs {
  listenHost: string;
  /** RETROSPECTICUS_BIND: the host address Docker publishes the port on, passed into the container by compose. */
  bind: string | undefined;
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>;
  inContainer: boolean;
}

function bracket(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

/**
 * Hosts to put in the first-run setup link so it can be clicked. A wildcard
 * bind is not an address; outside a container the machine's own addresses
 * stand in for it, but inside one they are the container's, which a browser
 * cannot reach, so only the published address from compose will do.
 */
export function setupHosts({ listenHost, bind, interfaces, inContainer }: SetupHostInputs): string[] {
  const published = bind?.trim();
  if (published && published !== "0.0.0.0" && published !== "::") return [bracket(published)];
  if (listenHost !== "0.0.0.0" && listenHost !== "::") return [bracket(listenHost)];
  if (inContainer) return [PLACEHOLDER];
  const found: string[] = [];
  for (const list of Object.values(interfaces)) {
    for (const info of list ?? []) {
      if (info.internal) continue;
      if (info.family === "IPv6" && (listenHost === "0.0.0.0" || /^fe80:/i.test(info.address))) continue;
      if (info.family === "IPv4" && info.address.startsWith("169.254.")) continue;
      found.push(bracket(info.address));
    }
  }
  found.sort((a, b) => Number(a.startsWith("[")) - Number(b.startsWith("[")));
  return found.length > 0 ? found : [PLACEHOLDER];
}

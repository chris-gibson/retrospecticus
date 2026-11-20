import { describe, expect, test } from "bun:test";
import type { NetworkInterfaceInfo } from "node:os";
import { setupHosts } from "../src/setup-hosts.ts";

function iface(address: string, family: "IPv4" | "IPv6", internal = false): NetworkInterfaceInfo {
  return { address, family, internal, netmask: "", mac: "", cidr: null, ...(family === "IPv6" ? { scopeid: 0 } : {}) } as NetworkInterfaceInfo;
}

const interfaces = {
  lo: [iface("127.0.0.1", "IPv4", true), iface("::1", "IPv6", true)],
  eth0: [iface("192.168.1.10", "IPv4"), iface("fe80::1", "IPv6"), iface("fd00::10", "IPv6")],
  tailscale0: [iface("100.64.0.7", "IPv4")],
  docker0: [iface("169.254.3.3", "IPv4")],
};

describe("setupHosts", () => {
  test("a specific listen address is used as is", () => {
    expect(setupHosts({ listenHost: "192.168.1.10", bind: undefined, interfaces, inContainer: false })).toEqual(["192.168.1.10"]);
    expect(setupHosts({ listenHost: "fd00::10", bind: undefined, interfaces, inContainer: false })).toEqual(["[fd00::10]"]);
  });

  test("the published address from compose wins over a wildcard bind", () => {
    expect(setupHosts({ listenHost: "0.0.0.0", bind: "100.64.0.7", interfaces, inContainer: true })).toEqual(["100.64.0.7"]);
  });

  test("inside a container without it, the address stays a placeholder", () => {
    expect(setupHosts({ listenHost: "0.0.0.0", bind: undefined, interfaces, inContainer: true })).toEqual(["<this server's address>"]);
  });

  test("outside a container a wildcard bind lists the machine's reachable addresses", () => {
    expect(setupHosts({ listenHost: "0.0.0.0", bind: undefined, interfaces, inContainer: false })).toEqual(["192.168.1.10", "100.64.0.7"]);
    expect(setupHosts({ listenHost: "::", bind: "", interfaces, inContainer: false })).toEqual(["192.168.1.10", "100.64.0.7", "[fd00::10]"]);
  });
});

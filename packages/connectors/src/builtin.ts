import { ConnectorRegistry } from './sdk';

/** The connectors that ship with the hub (spec §8.2). GitHub, Jira and Confluence land in M2. */
export function builtinConnectors(): ConnectorRegistry {
  return new ConnectorRegistry([]);
}

import { github } from './github';
import { ConnectorRegistry } from './sdk';

/** The connectors that ship with the hub (spec §8.2). Jira and Confluence follow in M2. */
export function builtinConnectors(): ConnectorRegistry {
  return new ConnectorRegistry([github]);
}

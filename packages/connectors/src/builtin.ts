import { confluence } from './confluence';
import { gcal } from './gcal';
import { github } from './github';
import { jira } from './jira';
import { ConnectorRegistry } from './sdk';
import { slack } from './slack';

/** The connectors that ship with the hub (spec §8.2). */
export function builtinConnectors(): ConnectorRegistry {
  return new ConnectorRegistry([github, jira, confluence, slack, gcal]);
}

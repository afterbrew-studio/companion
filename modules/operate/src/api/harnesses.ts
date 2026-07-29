import type { HarnessDescriptor } from '../contract/index.js';
import { MOXXY_CAPABILITIES } from '../exec/gateway-client.js';

/**
 * The agent runtimes this build knows how to run, each carrying the capability
 * declaration its own implementation makes. Nothing here restates what a
 * harness can do: a second table would drift from the client that implements it
 * on the first release where the two disagree.
 */
export const MOXXY_HARNESS: HarnessDescriptor = {
  id: 'moxxy',
  label: 'moxxy',
  capabilities: MOXXY_CAPABILITIES,
};

export const HARNESSES: readonly HarnessDescriptor[] = [MOXXY_HARNESS];

/**
 * What a recorded harness id means here.
 *
 * An id this build does not implement can only come from a run started under a
 * harness since removed, and the honest answer for it is a declaration that
 * claims nothing: it will raise no approval, report no usage and offer no
 * models, all of which are true of a harness that is not here. Substituting
 * moxxy's answers would make a dead run look like a live one.
 */
export function describeHarness(id: string): HarnessDescriptor {
  return HARNESSES.find((h) => h.id === id) ?? claimsNothing(id);
}

function claimsNothing(id: string): HarnessDescriptor {
  return {
    id,
    label: id,
    capabilities: {
      approvals: 'policy',
      usage: 'none',
      models: 'none',
      sessionControls: { model: false, provider: false, mode: false, autoApprove: false, commands: false },
    },
  };
}

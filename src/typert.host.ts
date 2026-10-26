import { TYPERT_REMOTE } from './remote.js'
/** Host and Client use the exact same strict invocation descriptions. */
export const TYPERT = {
  package: 'dsh-mood', face: 'host', schemas: [],
  get invocations() { return TYPERT_REMOTE.descriptors },
  model: { services: [], events: [], objects: [] },
}

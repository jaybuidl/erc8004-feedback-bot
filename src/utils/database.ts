// Compatibility layer: Database and related utilities from consolidated Store
export {
  Store as Database,
  resetStore as resetDatabase,
  getStore as getDatabase,
} from '../store';

export type { CollateralizationEvent, AgentEligibility } from '../types';

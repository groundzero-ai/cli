/**
 * Types for the install flow
 */

import type { RemotePullFailureReason } from '../remote-pull.js';

export type InstallScenario = 'local-primary' | 'remote-primary' | 'force-remote';

export type InstallResolutionMode = 'default' | 'remote-primary' | 'local-only';

export interface PackageRemoteResolutionOutcome {
  name: string;
  reason: RemotePullFailureReason;
  message: string;
}

/**
 * Types for the install flow
 */

export type InstallScenario = 'local-primary' | 'remote-primary' | 'force-remote';

export interface InstallPlan {
  scenario: InstallScenario;
  warnings: string[];
}

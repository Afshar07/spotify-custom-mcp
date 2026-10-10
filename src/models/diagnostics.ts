export enum EDiagnosticStatus {
  Pass = 'pass',
  Fail = 'fail',
  /** Not run because an earlier check failed, or not applicable. */
  Skipped = 'skipped',
}

export enum ERepairAction {
  ReinstallApp = 'reinstall_app',
  Reconnect = 'reconnect',
  RepairOpenCode = 'repair_opencode',
  EnterClientId = 'enter_client_id',
  ManualChatGpt = 'manual_chatgpt',
}

export interface IDiagnosticCheck {
  id: string;
  title: string;
  status: EDiagnosticStatus;
  /** Plain-language result for non-developers. */
  detail: string;
  repair?: ERepairAction;
}

export interface IDiagnosticsReport {
  ok: boolean;
  toolCount: number | null;
  checks: IDiagnosticCheck[];
}

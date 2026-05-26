const KEY = 'myrpg_dev_mode';
const KEY_DISABLE_AIDM = 'myrpg_disable_aidm';

function readUrlParam(name: string): boolean | null {
  const param = new URLSearchParams(window.location.search).get(name);
  if (param === 'true') return true;
  if (param === 'false') return false;
  return null;
}

export const DevMode = {
  get enabled(): boolean {
    const urlOverride = readUrlParam('dev');
    if (urlOverride !== null) return urlOverride;
    const stored = localStorage.getItem(KEY);
    return stored === null ? true : stored === 'true';
  },
  /**
   * When true, the client short-circuits AIDM requests with a canned silent
   * reply instead of calling the server. Used to validate that an encounter
   * plays end-to-end on the deterministic layer alone (US-068 acceptance
   * criterion). Toggle via `?disableAIDM=true` URL param or by setting
   * `localStorage.myrpg_disable_aidm = 'true'`.
   */
  get disableAIDM(): boolean {
    const urlOverride = readUrlParam('disableAIDM');
    if (urlOverride !== null) return urlOverride;
    return localStorage.getItem(KEY_DISABLE_AIDM) === 'true';
  },
};

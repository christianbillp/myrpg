const KEY = 'myrpg_dev_mode';

function readUrlParam(): boolean | null {
  const param = new URLSearchParams(window.location.search).get('dev');
  if (param === 'true') return true;
  if (param === 'false') return false;
  return null;
}

export const DevMode = {
  get enabled(): boolean {
    const urlOverride = readUrlParam();
    if (urlOverride !== null) return urlOverride;
    const stored = localStorage.getItem(KEY);
    return stored === null ? true : stored === 'true';
  },
};

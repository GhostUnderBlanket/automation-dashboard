export interface AppSettings {
  restBaseUrl:   string;
  restToken:     string;
  defaultShell:  'cmd' | 'powershell' | 'bash';
  nodeTimeout:   number;
  stopOnError:   boolean;
  closeToTray:   boolean;
  theme:         'dark' | 'light';
  runLogLimit:   number;
  snapEnabled:   boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  restBaseUrl:   '',
  restToken:     '',
  defaultShell:  'powershell',
  nodeTimeout:   30,
  stopOnError:   true,
  closeToTray:   true,
  theme:         'dark',
  runLogLimit:   100,
  snapEnabled:   true,
};

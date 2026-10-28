import { useState } from 'react';

import { loadRxLanguage, saveRxLanguage, type RxLanguage } from './rx';

// The viewer's chosen prescription language (English / Hindi / both),
// remembered on this device.
export function useRxLanguage(): [RxLanguage, (l: RxLanguage) => void] {
  const [lang, setLang] = useState<RxLanguage>(loadRxLanguage);
  return [
    lang,
    (l: RxLanguage) => {
      setLang(l);
      saveRxLanguage(l);
    },
  ];
}

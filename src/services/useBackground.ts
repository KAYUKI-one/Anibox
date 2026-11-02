import { useEffect, useState } from 'react';
import type { PageAppearance } from '../domain/types';
import { desktop } from './desktop';

export function useBackground(appearance: PageAppearance | undefined, directory?: string) {
  const [loaded, setLoaded] = useState<{ key: string; value: string | null }>({ key: '', value: null });
  const name = appearance?.imageFile;
  useEffect(() => {
    if (!desktop.available || !name) {
      setLoaded({ key: '', value: null });
      return;
    }
    let disposed = false;
    const refresh = () =>
      desktop
        .loadBackground(name)
        .then((value) => {
          if (!disposed) setLoaded({ key: name, value });
        })
        .catch(() => {
          if (!disposed) setLoaded({ key: name, value: null });
        });
    void refresh();
    window.addEventListener('focus', refresh);
    return () => {
      disposed = true;
      window.removeEventListener('focus', refresh);
    };
  }, [name, directory]);
  return appearance?.image ?? (loaded.key === name ? loaded.value : null);
}

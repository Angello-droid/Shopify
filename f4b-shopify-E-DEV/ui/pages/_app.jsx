import { AppProvider } from '@shopify/polaris';
import enTranslations from '@shopify/polaris/locales/en.json';

import '@shopify/polaris/build/esm/styles.css';

function MyApp({ Component, pageProps }) {
  return (
    <AppProvider i18n={enTranslations}>
      <Component {...pageProps} />
    </AppProvider>
  );
}

export default MyApp;

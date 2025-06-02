import axios from 'axios';
import {
  Card,
  Page,
  Layout,
  FormLayout,
  TextField,
  Button,
  Form,
  Toast,
  Frame,
} from '@shopify/polaris';
import { useRouter } from 'next/router';
import { useCallback, useState } from 'react';
import { config } from '../../config';
import { logger } from '../../logger';
import { LoggableAxiosError } from '../../server/utils';

export default function Index({ keys: savedKeys, shop, serverBaseUrl }) {
  const router = useRouter();
  const keysStater = { prodSk: '', prodPk: '', testSk: '', testPk: '' };
  const [keys, setKeys] = useState({ ...keysStater, ...savedKeys });
  const [fieldErrors, setFieldErrors] = useState({ ...keysStater });
  const [loading, setLoading] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [toast, setToast] = useState({ show: false, content: '', isError: false });

  const handleInput = useCallback(
    (val, id) => {
      setFieldErrors({ ...fieldErrors, [id]: '' });
      return setKeys({ ...keys, [id]: val });
    },
    [keys, fieldErrors],
  );
  const handleSubmit = useCallback(async () => {
    setLoading(true);
    let hasInvalid = false;
    const regex = {
      prodSk: /^FLWSECK-.{16,}-X$/,
      prodPk: /^FLWPUBK-.{16,}-X$/,
      testSk: /^FLWSECK_TEST-.{16,}-X$/,
      testPk: /^FLWPUBK_TEST-.{16,}-X$/,
      prodSkFormat: 'FLWSECK-********************************-X',
      prodPkFormat: 'FLWPUBK-********************************-X',
      testSkFormat: 'FLWSECK_TEST-********************************-X',
      testPkFormat: 'FLWPUBK_TEST-********************************-X',
    };

    const errors = Object.keys(keys)
      .map((k) => {
        const val = keys[k]?.trim();
        const returnData = { [k]: '' };

        if (!val) {
          hasInvalid = true;
          returnData = { [k]: 'This field is required.' };
        }

        if (val && !regex[k].test(val)) {
          hasInvalid = true;
          returnData = { [k]: `Invalid key format. Should be: ${regex[`${k}Format`]}` };
        }

        return returnData;
      })
      .reduce((a, c) => ({ ...a, ...c }), {});

    setFieldErrors(errors);
    if (hasInvalid) return setLoading(false);

    const url = `${serverBaseUrl}/api/settings`;

    let res;
    try {
      res = await axios.post(url, {
        sk: keys.prodSk,
        pk: keys.prodPk,
        test_sk: keys.testSk,
        test_pk: keys.testPk,
        shop,
      });

      const redirUrl = res?.data?.redirect_url;
      if (redirUrl) {
        setToast({ show: true, content: 'Settings updated', isError: false });
        router.push(redirUrl);
      }
    } catch (error) {
      const msg = error?.response?.data?.message || 'An error occured';
      setToast({ show: true, content: msg, isError: true });
    }

    setLoading(false);
    setJustSaved(true);
    setTimeout(() => {
      setJustSaved(false);
      setToast({ show: false, content: '', isError: false });
    }, 3000);
  }, [keys, router, shop, serverBaseUrl]);

  return (
    <Frame>
      <Page
        title="Flutterwave Payment Settings"
        compactTitle
        narrowWidth
        subtitle="Flutterwave helps you collect payments"
        primaryAction={{
          content: 'Get API Keys',
          external: true,
          url: 'https://app.flutterwave.com/login',
        }}
        secondaryActions={[
          {
            content: 'How To Setup',
            external: true,
            url: 'https://flutterwave.com/us/support/integrations/how-to-integrate-flutterwave-into-shopify',
          },
          {
            content: 'Create Flutterwave Account',
            external: true,
            url: 'https://app.flutterwave.com/register',
          },
        ]}
      >
        <Layout>
          <Layout.AnnotatedSection id="apiKeySettings" title="Configure your API Keys">
            <Card sectioned>
              <Form onSubmit={handleSubmit}>
                <FormLayout>
                  <TextField
                    label="Public Key"
                    onChange={handleInput}
                    autoComplete="off"
                    value={keys.prodPk}
                    id="prodPk"
                    monospaced
                    requiredIndicator
                    error={fieldErrors.prodPk && fieldErrors.prodPk}
                  />
                  <TextField
                    label="Secret Key"
                    onChange={handleInput}
                    autoComplete="off"
                    value={keys.prodSk}
                    id="prodSk"
                    monospaced
                    requiredIndicator
                    error={fieldErrors.prodSk && fieldErrors.prodSk}
                  />
                  <TextField
                    label="Test Public Key"
                    onChange={handleInput}
                    autoComplete="off"
                    value={keys.testPk}
                    id="testPk"
                    monospaced
                    requiredIndicator
                    error={fieldErrors.testPk && fieldErrors.testPk}
                  />
                  <TextField
                    label="Test Secret Key"
                    onChange={handleInput}
                    autoComplete="off"
                    value={keys.testSk}
                    id="testSk"
                    monospaced
                    requiredIndicator
                    error={fieldErrors.testSk && fieldErrors.testSk}
                  />

                  <Button submit primary loading={loading} disabled={loading || justSaved}>
                    Submit
                  </Button>
                  {toast.show && (
                    <Toast
                      content={toast.content}
                      error={toast.isError}
                      onDismiss={() => setToast({ show: false, content: '', isError: false })}
                    />
                  )}
                </FormLayout>
              </Form>
            </Card>
          </Layout.AnnotatedSection>
        </Layout>
      </Page>
    </Frame>
  );
}

export async function getServerSideProps({ query }) {
  const serverBaseUrl = config.appBaseURL;
  const url = `${serverBaseUrl}/api/settings`;
  const shop = query.shop;

  let settings;

  try {
    settings = await axios.get(url, { params: query });
  } catch (error) {
    logger.error(new LoggableAxiosError(error, { message: 'next getServerSideProps failed' }));
  }
  const keys = settings?.data?.data || {};

  return { props: { keys, shop, serverBaseUrl } };
}

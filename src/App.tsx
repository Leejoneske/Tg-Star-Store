import { useState } from 'react';
import { Intro } from './screens/Intro';
import { Buy } from './screens/Buy';
import { Status } from './screens/Status';
import './styles/common.css';

export interface BuyPrefill {
  username?: string;
  stars?: number;
  isPremium?: boolean;
  premiumDuration?: number;
}

type Route =
  | { name: 'intro' }
  | { name: 'buy' }
  | { name: 'status'; orderId: string; stars: number | null; isPremium: boolean; premiumDuration: number | null };

const SEEN_INTRO_KEY = 'starstore_minipay_seen_intro';

function readPrefill(): BuyPrefill {
  const params = new URLSearchParams(location.search);
  const prefill: BuyPrefill = {};
  if (params.get('username')) prefill.username = params.get('username')!.replace(/^@/, '');
  if (params.get('stars')) prefill.stars = Number(params.get('stars')) || undefined;
  if (params.get('premium') === '1') prefill.isPremium = true;
  if (params.get('duration')) prefill.premiumDuration = Number(params.get('duration')) || undefined;
  return prefill;
}

function App() {
  const [prefill] = useState<BuyPrefill>(readPrefill);
  const [route, setRoute] = useState<Route>(() =>
    sessionStorage.getItem(SEEN_INTRO_KEY) || Object.keys(readPrefill()).length > 0
      ? { name: 'buy' }
      : { name: 'intro' }
  );

  if (route.name === 'intro') {
    return (
      <Intro
        onContinue={() => {
          sessionStorage.setItem(SEEN_INTRO_KEY, '1');
          setRoute({ name: 'buy' });
        }}
      />
    );
  }

  if (route.name === 'status') {
    return (
      <Status
        orderId={route.orderId}
        stars={route.stars}
        isPremium={route.isPremium}
        premiumDuration={route.premiumDuration}
        onStartOver={() => setRoute({ name: 'buy' })}
      />
    );
  }

  return (
    <Buy
      prefill={prefill}
      onOrderPlaced={(orderId, stars, isPremium, premiumDuration) =>
        setRoute({ name: 'status', orderId, stars, isPremium, premiumDuration })
      }
    />
  );
}

export default App;

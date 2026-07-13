// PLACEHOLDER ICONS — no generated artwork, no gradients. Drop your own
// files in here and the app will pick them up on the next rebuild, no
// further code changes needed:
//
//   minipay-app/public/icons/star.svg      -> served at /minipay/icons/star.svg
//   minipay-app/public/icons/premium.svg   -> served at /minipay/icons/premium.svg
//
// (PNG works too — just update the filenames below to match.)
export function TelegramStarIcon({ size = 24 }: { size?: number }) {
  return (
    <img
      src={`${import.meta.env.BASE_URL}icons/star.svg`}
      alt="Star"
      width={size}
      height={size}
      style={{ display: 'block' }}
    />
  );
}

export function TelegramPremiumIcon({ size = 24 }: { size?: number }) {
  return (
    <img
      src={`${import.meta.env.BASE_URL}icons/premium.svg`}
      alt="Premium"
      width={size}
      height={size}
      style={{ display: 'block' }}
    />
  );
}

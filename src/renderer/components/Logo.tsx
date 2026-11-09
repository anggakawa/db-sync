import headerSvg from '../assets/header.svg?raw';

// The supplied lockup, inlined so the wordmark follows the text colour and the mark follows --logo-mark in both themes.
const LOCKUP = headerSvg
  .replace(/fill="#1B2430"/g, 'fill="currentColor"')
  .replace(/fill="#1F5FBF"/g, 'fill="var(--logo-mark, #1F5FBF)"')
  .replace('<svg ', '<svg aria-hidden="true" focusable="false" ');

/** The DB Sync lockup, 32 px high. The accessible name "DB Sync" stays as text for screen readers. */
export function Logo() {
  return (
    <>
      <span className="logo" dangerouslySetInnerHTML={{ __html: LOCKUP }} />
      <span className="sr-only">DB Sync</span>
    </>
  );
}

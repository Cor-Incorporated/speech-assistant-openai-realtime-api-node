import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import V2App from './v2/V2App';
import './styles.css';

// Hash-based split: #v2 / #v2-<tab> renders the admin v2 console; the legacy
// call-log dashboard stays the default so existing bookmarks keep working.
const Root = () => {
    const [, force] = React.useReducer((x) => x + 1, 0);
    React.useEffect(() => {
        const onHash = () => force();
        window.addEventListener('hashchange', onHash);
        return () => window.removeEventListener('hashchange', onHash);
    }, []);
    return window.location.hash.startsWith('#v2') ? <V2App /> : <App />;
};

createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
        <Root />
    </React.StrictMode>
);

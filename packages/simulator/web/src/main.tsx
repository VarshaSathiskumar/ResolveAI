import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// Not wrapped in StrictMode: its double mount would load each card's sandbox twice, and a sandbox iframe must only be set up once.
createRoot(document.getElementById('root')!).render(<App />);

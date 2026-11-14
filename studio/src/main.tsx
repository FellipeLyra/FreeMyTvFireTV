import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { useEditor } from './store/editor';

// Development builds expose the store for the end-to-end test (studio/scripts/e2e.mjs).
if (import.meta.env.DEV) (window as unknown as { __fmtvStudio: typeof useEditor }).__fmtvStudio = useEditor;

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <App />
    </StrictMode>,
);

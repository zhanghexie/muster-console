import React from 'react';
import { createRoot } from 'react-dom/client';
import './ui-verification-ttf.css';
import rawSource from './ui-verification-raw.js?raw';

createRoot(document.getElementById('root')!).render(<div className="ttf-fixture" data-raw={rawSource}>TrueType fixture</div>);

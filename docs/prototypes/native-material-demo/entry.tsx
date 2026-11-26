import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../../src/renderer/src/styles/base.css';
import './styles.css';
import MaterialDemo from './App';
createRoot(document.getElementById('root')!).render(<MaterialDemo />);

/**
 * App.jsx — root component with React Router.
 *
 * Routes:
 *   /          → SenderPage  (drop file, create room, share link)
 *   /r/:roomId → ReceiverPage (join room OR sender landing after peer joins)
 *   *          → redirect to /
 */

import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import SenderPage from './pages/SenderPage';
import ReceiverPage from './pages/ReceiverPage';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<SenderPage />} />
        <Route path="/r/:roomId" element={<ReceiverPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import App from "./App";
import Landing from "./landing/Landing";
import Auth from "./pages/Auth";
import { AuthProvider, RequireSession } from "./lib/auth";
import "leaflet/dist/leaflet.css";
import "./styles.css";
import "./auth.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          {/* Marketing entry page. Renders none of the control-room chrome. */}
          <Route path="/" element={<Landing />} />

          {/* Auth sits outside the app shell: a sidebar full of navigation you
              cannot use yet is noise on the one screen that has a single job. */}
          <Route path="/signin" element={<Auth mode="signin" />} />
          <Route path="/signup" element={<Auth mode="signup" />} />

          {/* Everything else is the control room, behind a session. */}
          <Route
            path="/*"
            element={
              <RequireSession>
                <App />
              </RequireSession>
            }
          />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);

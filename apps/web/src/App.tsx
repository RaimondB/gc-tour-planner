// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { MapView } from "./features/map/MapView.js";

export default function App(): JSX.Element {
  return (
    <div className="app">
      <header className="app-header">
        <h1>gc-tour-planner</h1>
        <p>Plan closed-loop geocaching tours from filtered cache clusters.</p>
      </header>
      <main className="app-main">
        <MapView />
      </main>
      <footer className="app-footer">
        Map data &copy;{" "}
        <a href="https://www.openstreetmap.org/copyright">
          OpenStreetMap contributors
        </a>
      </footer>
    </div>
  );
}

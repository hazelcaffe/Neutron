import { baseFromScript } from "./base";

// Imported first by worker entry points served at <base>runtime/<name>.js.
baseFromScript(self.location.href, 1);

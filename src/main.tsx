import "@fontsource-variable/inter/wght.css";
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "./app.css";
import { createTheme, MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { createRoot } from "react-dom/client";
import { App } from "./App";

const theme = createTheme({
	fontFamily: '"Inter Variable", system-ui, -apple-system, "Segoe UI", sans-serif',
	fontFamilyMonospace: 'ui-monospace, "SFMono-Regular", "Cascadia Mono", Menlo, monospace',
	primaryColor: "blue",
	defaultRadius: "md",
});

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
createRoot(root).render(
	<MantineProvider theme={theme} defaultColorScheme="auto">
		<Notifications position="bottom-right" />
		<App />
	</MantineProvider>,
);

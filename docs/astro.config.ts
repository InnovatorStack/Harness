import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
    site: "https://innovatorstack.github.io",
    base: "/Harness",
    trailingSlash: "always",
    integrations: [
        starlight({
            title: "Harness",
            description: "Set up and test Aras Innovator solutions locally with Bun.",
            logo: {
                light: "./src/assets/mark.svg",
                dark: "./src/assets/mark-on-dark.svg",
            },
            favicon: "/favicon.svg",
            expressiveCode: { defaultProps: { frame: "none" } },
            social: [
                {
                    icon: "github",
                    label: "GitHub",
                    href: "https://github.com/InnovatorStack/Harness",
                },
            ],
            editLink: { baseUrl: "https://github.com/InnovatorStack/Harness/edit/main/docs/" },
            customCss: ["./src/styles/docs.css"],
            credits: false,
            sidebar: [
                {
                    label: "Get started",
                    items: [
                        { label: "Quickstart", slug: "index" },
                        { label: "Packages", slug: "setup/packages" },
                        { label: "Fixtures", slug: "setup/fixtures" },
                        { label: "Configuration", slug: "setup/configuration" },
                    ],
                },
                {
                    label: "Write tests",
                    items: [
                        { label: "Actions and Methods", slug: "guides/testing" },
                        { label: "Mock a dependency", slug: "guides/mocking" },
                        { label: "Inspect an execution", slug: "guides/reports" },
                        { label: "Control a test", slug: "guides/test-controls" },
                        { label: "Run C# Methods", slug: "guides/csharp" },
                    ],
                },
                {
                    label: "Reference",
                    items: [
                        { label: "API", slug: "reference/api" },
                        { label: "Compatibility", slug: "reference/compatibility" },
                        { label: "AML queries", slug: "reference/queries" },
                        { label: "Versions and relationships", slug: "reference/versions" },
                        { label: "Events", slug: "reference/events" },
                        { label: "Lifecycles", slug: "reference/lifecycles" },
                        { label: "Permissions", slug: "reference/permissions" },
                    ],
                },
                { label: "Contributing", slug: "contributing" },
            ],
        }),
    ],
});

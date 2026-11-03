// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modified for Mail App, 2026: Mail App title, icons and language; app manifest and service worker; the company's branding (name, logo and colour) read with the page.

import {
	Button,
	Empty,
	LinkProvider,
	Loader,
	Toasty,
	TooltipProvider,
} from "@cloudflare/kumo";
import { WarningIcon } from "@phosphor-icons/react";
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { forwardRef, useEffect, useState } from "react";
import {
	isRouteErrorResponse,
	Links,
	Meta,
	Outlet,
	Link as RouterLink,
	Scripts,
	ScrollRestoration,
	useRouteLoaderData,
	type LoaderFunctionArgs,
} from "react-router";
import { ApiError, SIGN_IN_EVENT } from "~/services/api";
import { registerServiceWorker } from "~/lib/app-mode";
import { watchForNewVersion } from "~/lib/new-version";
import brand from "~/copy/brand.en-GB.json";
import { applyBrand } from "~/lib/brand";
import { brandColours, brandCss, brandName, cleanBranding, isBranded, logoIsIcon, logoUrl, type Branding } from "shared/branding";
import { loadBranding } from "../workers/lib/branding";
import "./index.css";

// Mail App: the company's branding (Admin > Branding), read once with the page. Saving it reloads the page.
export async function loader({ context }: LoaderFunctionArgs) {
	return { branding: await loadBranding(context.cloudflare?.env?.BUCKET) };
}
export const shouldRevalidate = () => false;

function makeQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: 30_000,
				refetchOnWindowFocus: false,
				retry: (failureCount, error) => {
					// Don't retry 4xx errors (not found, unauthorized, etc.)
					if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
						return false;
					}
					return failureCount < 2;
				},
			},
		},
		mutationCache: new MutationCache({
			onError: (error) => {
				// Global fallback for mutations that don't handle errors themselves.
				// Consumers using mutateAsync + try/catch handle their own errors.
				console.error("Mutation failed:", error);
			},
		}),
	});
}

// Lazy singleton for the browser — avoids module-scope instantiation that
// leaks cache across SSR requests.
let browserQueryClient: QueryClient | undefined;
function getQueryClient() {
	if (typeof window === "undefined") {
		// SSR: always create a fresh client per request to prevent cross-user cache leaks
		return makeQueryClient();
	}
	// Browser: reuse the same client across navigations
	if (!browserQueryClient) browserQueryClient = makeQueryClient();
	return browserQueryClient;
}

const KumoLink = forwardRef<
	HTMLAnchorElement,
	React.AnchorHTMLAttributes<HTMLAnchorElement> & { href?: string }
>(function KumoLink({ href, ...props }, ref) {
	if (href && !href.startsWith("http")) {
		return (
			<RouterLink to={href} ref={ref} {...(props as Record<string, unknown>)} />
		);
	}
	return <a href={href} ref={ref} {...props} />;
});

export function Layout({ children }: { children: React.ReactNode }) {
	const data = useRouteLoaderData("root") as { branding?: Branding } | undefined;
	const branding = data?.branding ?? cleanBranding(null);
	applyBrand(branding);
	const name = brandName(branding);
	const logo = logoUrl(branding);
	const icon = logo && logoIsIcon(branding.logo) ? logo : null;
	return (
		<html lang="en-GB">
			<head>
				<meta charSet="UTF-8" />
				{icon ? (
					<link rel="icon" type={branding.logo!.type} href={icon} />
				) : (<>
					<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
					<link
						rel="icon"
						type="image/x-icon"
						href="/favicon.ico"
						sizes="48x48 32x32 16x16"
					/>
				</>)}
				<link rel="apple-touch-icon" href={icon && branding.logo!.type === "image/png" ? icon : "/apple-touch-icon.png"} />
				{/* Mail App: lets Mail App be added to the Dock or home screen. Sent with the sign-in cookie, as the whole site is behind Cloudflare sign-in. A branded install's has its own name and icon. */}
				<link rel="manifest" href={isBranded(branding) || branding.colour ? "/api/v1/branding/manifest" : "/manifest.webmanifest"} crossOrigin="use-credentials" />
				<meta name="viewport" content="width=device-width, initial-scale=1.0" />
				<meta name="theme-color" content={brandColours(branding.colour).brand} />
				<meta name="apple-mobile-web-app-title" content={name} />
				<title>{name}</title>
				{branding.colour && <style>{brandCss(branding)}</style>}
				<Meta />
				<Links />
			</head>
			<body className="bg-kumo-recessed text-kumo-default antialiased">
				{children}
				<ScrollRestoration />
				<Scripts />
			</body>
		</html>
	);
}

export function HydrateFallback() {
	return (
		<div className="flex items-center justify-center h-screen">
			<Loader size="lg" />
		</div>
	);
}

export default function App() {
	// Use useState to ensure each SSR request gets a fresh client while the
	// browser reuses the same singleton across navigations.
	const [queryClient] = useState(getQueryClient);
	useEffect(registerServiceWorker, []);
	useEffect(watchForNewVersion, []);
	return (
		<QueryClientProvider client={queryClient}>
			<LinkProvider component={KumoLink}>
				<TooltipProvider>
					<Toasty>
						<Outlet />
						<SignInAgain />
					</Toasty>
				</TooltipProvider>
			</LinkProvider>
		</QueryClientProvider>
	);
}

export function ErrorBoundary({ error }: { error: unknown }) {
	let title = "Something went wrong";
	let description = "An unexpected error occurred. Please try again.";
	let status: number | null = null;

	if (isRouteErrorResponse(error)) {
		status = error.status;
		if (error.status === 404) {
			title = "Page not found";
			description =
				"The page you're looking for doesn't exist or has been moved.";
		} else {
			title = `Error ${error.status}`;
			description = error.statusText || description;
		}
	} else if (error instanceof Error && import.meta.env.DEV) {
		description = error.message;
	}

	return (
		<div className="flex items-center justify-center min-h-screen p-8">
			<Empty
				icon={<WarningIcon size={48} className="text-kumo-inactive" />}
				title={status === 404 ? "404 — Page not found" : title}
				description={description}
				contents={
					<Button
						variant="primary"
						onClick={() => {
							window.location.href = "/";
						}}
					>
						Go Home
					</Button>
				}
			/>
		</div>
	);
}

/**
 * Mail App: shown when Mail App can't reach the mailbox, usually because the monthly Cloudflare sign-in has run
 * out. Reloading the page takes you to Cloudflare's sign-in, then straight back.
 */
function SignInAgain() {
	const [show, setShow] = useState(false);
	useEffect(() => {
		const on = () => setShow(true);
		window.addEventListener(SIGN_IN_EVENT, on);
		return () => window.removeEventListener(SIGN_IN_EVENT, on);
	}, []);
	if (!show) return null;
	return (
		<div role="alert" className="fixed inset-x-0 bottom-4 z-[60] mx-auto flex w-[min(92vw,30rem)] flex-wrap items-center gap-3 rounded-lg border border-kumo-line bg-kumo-base px-4 py-3 shadow-lg">
			<p className="flex-1 text-sm text-kumo-default">{brand.signInText}</p>
			<Button variant="primary" size="sm" onClick={() => window.location.reload()}>{brand.signInButton}</Button>
			<Button variant="ghost" size="sm" onClick={() => setShow(false)}>{brand.signInLater}</Button>
		</div>
	);
}

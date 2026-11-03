// Mail App addition (not part of upstream Agentic Inbox).
// The People page is now called Users and lives at /users. Old links and bookmarks still work.
import { Navigate } from "react-router";

export default function PeopleMoved() {
	return <Navigate to="/users" replace />;
}

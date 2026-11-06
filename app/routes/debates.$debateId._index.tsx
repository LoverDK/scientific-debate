import { Navigate, useParams } from "react-router";

import { debateEvidencePath } from "../lib/debate-paths";

export default function DebateIndexRedirect() {
  const { debateId = "" } = useParams();
  return <Navigate to={debateEvidencePath(debateId)} replace />;
}

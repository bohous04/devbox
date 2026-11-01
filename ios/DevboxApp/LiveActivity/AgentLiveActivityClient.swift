import Foundation

struct AgentLiveActivityRegistration: Encodable, Equatable {
    let deviceId: String
    let serverID: String
    let kind: String
    let token: String
    let activityId: String?
    let environment: String
    let optIn: Bool?
}

protocol AgentLiveActivityClient: AnyObject {
    func agentActivityState() async throws -> DevboxAgentActivityAttributes.ContentState
    func serverEndedAgentActivity(deviceID: String, serverID: String, activityID: String) async throws -> Bool
    func registerAgentActivity(_ registration: AgentLiveActivityRegistration) async throws
    func unregisterAgentActivities(deviceID: String, activityID: String?) async throws
}

extension DevdClient: AgentLiveActivityClient {
    func agentActivityState() async throws -> DevboxAgentActivityAttributes.ContentState {
        try await get("/api/live-activities/state")
    }

    func serverEndedAgentActivity(deviceID: String, serverID: String, activityID: String) async throws -> Bool {
        struct Disposition: Decodable { let serverEnded: Bool }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_."))
        guard let device = deviceID.addingPercentEncoding(withAllowedCharacters: allowed),
              let activity = activityID.addingPercentEncoding(withAllowedCharacters: allowed),
              let server = serverID.addingPercentEncoding(withAllowedCharacters: allowed) else {
            throw URLError(.badURL)
        }
        let result: Disposition = try await get("/api/live-activities/\(device)/\(activity)?serverID=\(server)")
        return result.serverEnded
    }

    func registerAgentActivity(_ registration: AgentLiveActivityRegistration) async throws {
        try await postVoid("/api/live-activities/register", body: registration)
    }

    func unregisterAgentActivities(deviceID: String, activityID: String?) async throws {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_."))
        guard let device = deviceID.addingPercentEncoding(withAllowedCharacters: allowed) else { return }
        var path = "/api/live-activities/\(device)"
        if let activityID, let activity = activityID.addingPercentEncoding(withAllowedCharacters: allowed) {
            path += "/\(activity)"
        }
        try await deleteVoid(path)
    }
}

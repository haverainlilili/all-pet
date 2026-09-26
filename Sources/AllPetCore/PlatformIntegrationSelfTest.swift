import Foundation

enum PlatformIntegrationSelfTest {
    static func run(_ expect: (Bool, String) -> Void) {
        let workbuddy = NativeTranscriptParser.parse(#"""
        {"type":"message","role":"user","sessionId":"wb-main","cwd":"/tmp/project","content":[{"type":"input_text","text":"最初任务"}]}
        {"type":"ai-title","aiTitle":"稳定标题"}
        {"type":"reasoning","content":[]}
        {"type":"function_call","name":"TodoWrite","arguments":"{\"todos\":[{\"status\":\"completed\"},{\"status\":\"pending\"}]}"}
        {"type":"function_call_result","status":"completed"}
        {"type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"完成"}]}
        """#, platform: .workbuddy)
        expect(workbuddy.task.phase == .done && workbuddy.task.sessionName == "稳定标题" && workbuddy.task.sessionID == "wb-main", "WorkBuddy native transcript identity/title/completion")
        expect(workbuddy.task.completedSteps == 1 && workbuddy.task.totalSteps == 2, "WorkBuddy native TodoWrite progress")
        let wbNext = NativeTranscriptParser.parse(#"{"type":"message","role":"user","sessionId":"wb-main","content":"下一轮"}"#, platform: .workbuddy, initial: workbuddy)
        expect(wbNext.task.phase == .thinking && wbNext.task.sessionName == "稳定标题", "WorkBuddy same-session new turn preserves name")
        let pi = NativeTranscriptParser.parse("""
        {"type":"session","version":3,"id":"pi-main","cwd":"/project"}
        {"type":"session_info","name":"Pi Task"}
        {"type":"message","id":"entry-not-session","parentId":null,"message":{"role":"user","content":"check"}}
        {"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","arguments":{"command":"echo test"}}],"stopReason":"toolUse"}}
        """, platform: .pi)
        expect(pi.task.phase == .running && pi.task.sessionID == "pi-main" && pi.task.sessionName == "Pi Task", "pi session ID differs from message/branch entry IDs")
        let piDone = NativeTranscriptParser.parse(#"{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"stopReason":"stop"}}"#, platform: .pi, initial: pi)
        expect(piDone.task.phase == .done, "pi explicit stop completes task")
        let piError = NativeTranscriptParser.parse(#"{"type":"message","message":{"role":"assistant","stopReason":"aborted"}}"#, platform: .pi, initial: pi)
        expect(piError.task.phase == .failed, "pi abort is a failed task")
        let qoder = NativeTranscriptParser.parse("""
        {"type":"session_meta","sessionId":"q-main","data":{"meta_type":"session_info","content":{"mode":"agent","session_type":"assistant"}}}
        {"type":"user","message":{"role":"user","content":"初始标题"}}
        {"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"ask_user_question","input":{}}]}}
        """, platform: .qoder)
        expect(qoder.task.phase == .waiting && qoder.task.sessionID == "q-main", "Qoder question waits for user")
        let qoderDone = NativeTranscriptParser.parse("""
        {"type":"progress","data":{"type":"hook_progress","hookEvent":"Stop"}}
        {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"最终回复"}]}}
        """, platform: .qoder, initial: qoder)
        expect(qoderDone.task.phase == .done, "Qoder final text after Stop stays completed")
        let cursor = NativeTranscriptParser.parse(#"{"role":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"还在继续"}]}}"#, platform: .cursor)
        expect(cursor.task.phase == .running, "Cursor partial assistant text never invents completion")
        let child = NativeTranscriptParser.parse(#"{"type":"user","isSidechain":true,"sessionId":"child","message":{"role":"user","content":"child"}}"#, platform: .qoder)
        expect(child.excluded, "Structured sidechain is excluded")
        let malformed = NativeTranscriptParser.parse("{broken\n{}\n", platform: .workbuddy)
        expect(malformed.task.phase == nil, "Malformed/unrelated records do not create fake active tasks")

        let home = FileManager.default.temporaryDirectory.appendingPathComponent("allpet-platform-tests-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: home) }
        do {
            try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
            var old = AllPetConfiguration.makeDefault(home: home)
            old.hiddenBubblePlatforms = nil
            let oldData = try JSONEncoder().encode(old)
            let decoded = try JSONDecoder().decode(AllPetConfiguration.self, from: oldData)
            expect(PlatformKind.allCases.count == 9 && PlatformKind.allCases.allSatisfy { decoded.showsBubbles(for: $0) }, "Old config defaults all nine bubble platforms visible")
            old.hiddenBubblePlatforms = ["cursor", "zcode"]
            let configURL = AllPetConfiguration.configURL(home: home)
            try old.save(to: configURL)
            let reloaded = AllPetConfiguration.load(from: configURL, home: home)
            expect(!reloaded.showsBubbles(for: .cursor) && !reloaded.showsBubbles(for: .zcode) && reloaded.showsBubbles(for: .pi), "Bubble visibility persists independently of monitoring")
            expect(reloaded.platformConfig(for: .cursor).enabled, "Hidden platform remains monitored")

            let original: [String: Any] = ["version": 1, "other": "retained", "hooks": ["stop": [["command": "user-existing-hook"]]]]
            let cursorConfig = home.appendingPathComponent(".cursor/hooks.json")
            try FileManager.default.createDirectory(at: cursorConfig.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONSerialization.data(withJSONObject: original).write(to: cursorConfig)
            _ = try AgentHookEvent.install(platform: .cursor, executable: "/tmp/All Pet's/allpet", home: home)
            _ = try AgentHookEvent.install(platform: .cursor, executable: "/tmp/All Pet's/allpet", home: home)
            let installed = try JSONSerialization.jsonObject(with: Data(contentsOf: cursorConfig)) as! [String: Any]
            let installedHooks = installed["hooks"] as! [String: [[String: Any]]]
            expect(installed["other"] as? String == "retained" && installedHooks["stop"]?.count == 2, "Hook install preserves existing hooks and is idempotent")
            let command = installedHooks["stop"]?.last?["command"] as? String ?? ""
            expect(command.contains("'\\''"), "Observer executable with spaces/apostrophe is shell-quoted")
            try Data("{invalid".utf8).write(to: cursorConfig)
            do { _ = try AgentHookEvent.install(platform: .cursor, executable: "/tmp/allpet", home: home); expect(false, "Broken hook config rejected") }
            catch { expect(try Data(contentsOf: cursorConfig) == Data("{invalid".utf8), "Broken hook config preserved") }

            func hook(_ event: String) throws {
                let data = try JSONSerialization.data(withJSONObject: ["hook_event_name": event, "conversation_id": "same-session", "workspace_roots": ["/project"]])
                try AgentHookEvent.record(platform: .cursor, input: data, home: home)
            }
            try hook("stop")
            let transcript = home.appendingPathComponent(".cursor/projects/demo/agent-transcripts/same-session.jsonl")
            try FileManager.default.createDirectory(at: transcript.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(#"{"role":"user","message":{"role":"user","content":"Real title"}}"#.utf8).write(to: transcript)
            let monitor = AllPetMonitor(configuration: .makeDefault(home: home), home: home)
            let status = monitor.snapshot().platforms.first { $0.platform == .cursor }
            expect(status?.tasks.count == 1 && status?.task?.phase == .done && status?.task?.sessionName == "Real title", "Hook completion and newer native transcript merge to one task")
            try hook("beforeSubmitPrompt")
            let next = monitor.snapshot().platforms.first { $0.platform == .cursor }
            expect(next?.task?.phase == .thinking, "Next Cursor turn replaces previous hook completion")
            let childInput = try JSONSerialization.data(withJSONObject: ["hook_event_name": "stop", "conversation_id": "child", "agent_id": "agent-1"])
            try AgentHookEvent.record(platform: .cursor, input: childInput, home: home)
            expect(monitor.snapshot().platforms.first { $0.platform == .cursor }?.tasks.count == 1, "Child hook cannot create a separate bubble")
        } catch { expect(false, "Platform integration fixture: \(error)") }
    }
}

/**
 * Bridge between the Lightning UI and the copilot orchestrator.
 *
 * The LWC cannot reach the Node service directly (CSP, and we do not want the
 * orchestrator's host in client-side code), so every call goes out through the
 * DevOps_Copilot Named Credential. The running user's identity travels with the
 * request — the orchestrator makes its own RBAC decision from it, and this class
 * never elevates anyone.
 */
public with sharing class DevOpsCopilotController {

    private static final String ENDPOINT = 'callout:DevOps_Copilot';

    public class CopilotResponse {
        @AuraEnabled public String conversationId { get; set; }
        @AuraEnabled public String status { get; set; }   // working | complete | error
        @AuraEnabled public String text { get; set; }
        @AuraEnabled public List<ToolActivity> activity { get; set; }
        @AuraEnabled public String error { get; set; }
    }

    public class ToolActivity {
        @AuraEnabled public String name { get; set; }
        @AuraEnabled public String state { get; set; }    // running | ok | failed
    }

    /**
     * Post a message and get back a conversation turn id. The turn runs
     * asynchronously on the orchestrator; the LWC polls pollTurn() for
     * progress, because Lightning Web Components cannot consume SSE.
     */
    @AuraEnabled
    public static CopilotResponse sendMessage(String message, String conversationId) {
        if (String.isBlank(message)) {
            throw new AuraHandledException('Message cannot be empty.');
        }
        Map<String, Object> payload = new Map<String, Object>{
            'message' => message,
            'conversation_id' => conversationId,
            'salesforce_user_id' => UserInfo.getUserId(),
            'username' => UserInfo.getUserName()
        };
        return callOut('/api/chat/turn', 'POST', JSON.serialize(payload));
    }

    /** Poll an in-flight turn. Returns status 'working' until the turn finishes. */
    @AuraEnabled
    public static CopilotResponse pollTurn(String conversationId, Integer sinceIndex) {
        String path = '/api/chat/poll?conversation_id=' + EncodingUtil.urlEncode(conversationId, 'UTF-8')
                    + '&since=' + String.valueOf(sinceIndex == null ? 0 : sinceIndex);
        return callOut(path, 'GET', null);
    }

    private static CopilotResponse callOut(String path, String method, String body) {
        HttpRequest req = new HttpRequest();
        req.setEndpoint(ENDPOINT + path);
        req.setMethod(method);
        req.setTimeout(120000);
        req.setHeader('Content-Type', 'application/json');
        // Identity for RBAC on the orchestrator side.
        req.setHeader('X-SF-User-Id', UserInfo.getUserId());
        req.setHeader('X-SF-Username', UserInfo.getUserName());
        req.setHeader('X-SF-Org-Id', UserInfo.getOrganizationId());
        // Proves the identity headers above came from this org's Apex rather
        // than anyone who discovered the endpoint. Stored in a protected
        // custom setting, never in source control.
        String secret = DevOps_Copilot_Config__c.getOrgDefaults().Shared_Secret__c;
        if (String.isNotBlank(secret)) {
            req.setHeader('X-Copilot-Secret', secret);
        }
        if (body != null) {
            req.setBody(body);
        }

        try {
            HttpResponse res = new Http().send(req);
            if (res.getStatusCode() >= 200 && res.getStatusCode() < 300) {
                return (CopilotResponse) JSON.deserialize(res.getBody(), CopilotResponse.class);
            }
            CopilotResponse err = new CopilotResponse();
            err.status = 'error';
            err.error = 'Copilot returned HTTP ' + res.getStatusCode() + ': ' + res.getBody();
            return err;
        } catch (Exception e) {
            CopilotResponse err = new CopilotResponse();
            err.status = 'error';
            err.error = 'Could not reach the copilot service: ' + e.getMessage();
            return err;
        }
    }

    /**
     * Environment ladder straight from Salesforce, so the panel renders
     * instantly without waiting on a model turn.
     */
    @AuraEnabled(cacheable=true)
    public static UserStorySummary getUserStorySummary(String featureId) {
        List<DevOps_User_Story__c> rows = [
            SELECT Id, Name, Feature_ID__c, Feature_Branch__c, Title__c, Status__c,
                   Overall_DevOps_Status__c, PR_Number__c, PR_Status__c, PR_URL__c,
                   Commit_Count__c, Latest_Commit_SHA__c, Latest_Commit_Message__c,
                   Current_Environment__c, Env_DEV_Status__c, Env_QA_Status__c,
                   Env_PROD_Status__c
            FROM DevOps_User_Story__c
            WHERE Feature_ID__c = :featureId
            WITH USER_MODE
            LIMIT 1
        ];
        if (rows.isEmpty()) {
            return null;
        }
        DevOps_User_Story__c us = rows[0];
        UserStorySummary s = new UserStorySummary();
        s.recordId = us.Id;
        s.name = us.Name;
        s.featureId = us.Feature_ID__c;
        s.branch = us.Feature_Branch__c;
        s.title = us.Title__c;
        s.status = us.Status__c;
        s.overallStatus = us.Overall_DevOps_Status__c;
        s.prNumber = us.PR_Number__c;
        s.prStatus = us.PR_Status__c;
        s.prUrl = us.PR_URL__c;
        s.commitCount = us.Commit_Count__c;
        s.latestCommit = us.Latest_Commit_SHA__c;
        s.latestCommitMessage = us.Latest_Commit_Message__c;
        s.environments = new List<EnvStatus>{
            env('DEV',   us.Env_DEV_Status__c),
            env('QA',    us.Env_QA_Status__c),
            env('PROD',  us.Env_PROD_Status__c)
        };
        return s;
    }

    private static EnvStatus env(String label, String value) {
        EnvStatus e = new EnvStatus();
        e.label = label;
        e.status = String.isBlank(value) ? 'Not Started' : value;
        e.icon = e.status == 'Succeeded' ? '✅'
               : e.status == 'Failed' ? '❌'
               : e.status == 'In Progress' ? '⏳'
               : e.status == 'Ready' ? '⏳'
               : '⚪';
        return e;
    }

    public class UserStorySummary {
        @AuraEnabled public Id recordId { get; set; }
        @AuraEnabled public String name { get; set; }
        @AuraEnabled public String featureId { get; set; }
        @AuraEnabled public String branch { get; set; }
        @AuraEnabled public String title { get; set; }
        @AuraEnabled public String status { get; set; }
        @AuraEnabled public String overallStatus { get; set; }
        @AuraEnabled public Decimal prNumber { get; set; }
        @AuraEnabled public String prStatus { get; set; }
        @AuraEnabled public String prUrl { get; set; }
        @AuraEnabled public Decimal commitCount { get; set; }
        @AuraEnabled public String latestCommit { get; set; }
        @AuraEnabled public String latestCommitMessage { get; set; }
        @AuraEnabled public List<EnvStatus> environments { get; set; }
    }

    public class EnvStatus {
        @AuraEnabled public String label { get; set; }
        @AuraEnabled public String status { get; set; }
        @AuraEnabled public String icon { get; set; }
    }
}

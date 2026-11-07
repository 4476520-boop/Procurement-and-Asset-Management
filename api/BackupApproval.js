

module.exports = async function (req, res) {
  // 1. Only accept POST requests from Zapier
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      error: "POST required"
    });
  }

  // 2. Retrieve the values sent by Zapier
  const { reqId, decision, role } = req.body || {};
  const token = req.headers["x-approval-token"];

  const requestId = String(reqId || "").trim();
  const approvalDecision = String(decision || "")
    .trim()
    .toLowerCase();
  const approvalRole = String(role || "")
    .trim()
    .toLowerCase();

  if (
    !/^\d+$/.test(requestId) ||
    !["approved", "rejected"].includes(approvalDecision) ||
    !["manager", "cfo", "auto"].includes(approvalRole)
  ) {
    return res.status(400).json({
      success: false,
      error: "Invalid request ID, decision or role"
    });
  }

  // 3. Verify the token for the appropriate role
  const expectedToken = {
    manager: process.env.manager_token,
    cfo: process.env.cfo_token,
    auto: process.env.auto_approval_token
  }[approvalRole];

  if (!expectedToken || token !== expectedToken) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized approval request"
    });
  }

  // 4. Configure Ivanti connection
  const tenant = (process.env.ivanti_tenant || "")
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");

  const apiKey = process.env.ivanti_api_key;

  if (!tenant || !apiKey) {
    return res.status(500).json({
      success: false,
      error: "Ivanti environment variables missing"
    });
  }

  const ivantiHeaders = {
    Authorization: apiKey,
    Accept: "application/json"
  };

  try {
    // 5. Retrieve the service request from Ivanti
    const filterQuery = encodeURIComponent(
      `ServiceReqNumber eq ${requestId}`
    );

    const searchUrl =
      `https://${tenant}/api/odata/businessobject/ServiceReqs` +
      `?$filter=${filterQuery}&$top=1`;

    const searchResponse = await fetch(searchUrl, {
      method: "GET",
      headers: ivantiHeaders
    });

    if (!searchResponse.ok) {
      throw new Error(
        `Ivanti lookup failed: ${searchResponse.status}`
      );
    }

    const searchData = await searchResponse.json();
    const ticket = searchData.value?.[0];

    if (!ticket) {
      return res.status(404).json({
        success: false,
        error: "Service request not found",
        reqId: requestId
      });
    }

    // 6. Read the price directly from Ivanti
    const price = Number(
      String(ticket.Price ?? "")
        .replace(/[$,\s]/g, "")
    );

    if (!Number.isFinite(price) || price < 0) {
      return res.status(422).json({
        success: false,
        error: "Invalid Price field in Ivanti"
      });
    }

    // 7. Determine the required approver
    // Below 1000: Automatic
    // 1000 to 2000: Manager
    // Above 2000: CFO only
    let requiredRole;

    if (price < 1000) {
      requiredRole = "auto";
    } else if (price <= 2000) {
      requiredRole = "manager";
    } else {
      requiredRole = "cfo";
    }

    if (approvalRole !== requiredRole) {
      return res.status(403).json({
        success: false,
        error: `This request requires ${requiredRole} approval`,
        reqId: requestId,
        price: price
      });
    }

    if (
      requiredRole === "auto" &&
      approvalDecision !== "approved"
    ) {
      return res.status(400).json({
        success: false,
        error: "Automatic approval must be approved"
      });
    }

    // 8. Check current Ivanti status
    const currentStatus = ticket.Status;

    if (
      currentStatus === "Approved" ||
      currentStatus === "Approval Rejected"
    ) {
      return res.status(200).json({
        success: true,
        reqId: requestId,
        price: price,
        status: currentStatus,
        alreadyProcessed: true,
        notify: false
      });
    }

    if (currentStatus !== "Pending") {
      return res.status(409).json({
        success: false,
        error: "Service request is not Pending",
        currentStatus: currentStatus
      });
    }

    // 9. Determine the final Ivanti status
    const finalStatus =
      approvalDecision === "approved"
        ? "Approved"
        : "Approval Rejected";

    // 10. Update the service request in Ivanti
    const patchUrl =
      `https://${tenant}/api/odata/businessobject/ServiceReqs` +
      `('${encodeURIComponent(ticket.RecId)}')`;

    const updateResponse = await fetch(patchUrl, {
      method: "PATCH",
      headers: {
        ...ivantiHeaders,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        Status: finalStatus
      })
    });

    if (!updateResponse.ok) {
      throw new Error(
        `Ivanti update failed: ${updateResponse.status}`
      );
    }

    // 11. Return the result to Zapier
    // Zapier will send the employee email using Gmail
    return res.status(200).json({
      success: true,
      reqId: requestId,
      price: price,
      role: requiredRole,
      decision: approvalDecision,
      status: finalStatus,
      employee_email: ticket.Email || "",
      employee_name: ticket.ProfileFullName || "",
      notify: true,
      message: "Ivanti service request updated successfully"
    });

  } catch (error) {
    console.error("BackupApproval Error:", error);

    return res.status(500).json({
      success: false,
      error: "Failed to process Ivanti approval"
    });
  }
};

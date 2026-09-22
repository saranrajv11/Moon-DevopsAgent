/**
 * Validates payment details before an order is submitted.
 */
public with sharing class PaymentValidator {

    public static Boolean isValid(Decimal amount) {
        return amount != null && amount > 0;
    }

    public static Boolean isSupportedMethod(String method) {
        return method == 'Card' || method == 'ACH' || method == 'Invoice';
    }
}

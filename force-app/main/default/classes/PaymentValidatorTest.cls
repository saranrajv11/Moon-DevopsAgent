@isTest
private class PaymentValidatorTest {

    @isTest
    static void rejectsNonPositiveAmounts() {
        System.assertEquals(false, PaymentValidator.isValid(null), 'null should be invalid');
        System.assertEquals(false, PaymentValidator.isValid(0), 'zero should be invalid');
        System.assertEquals(false, PaymentValidator.isValid(-5), 'negative should be invalid');
    }

    @isTest
    static void acceptsPositiveAmounts() {
        System.assertEquals(true, PaymentValidator.isValid(0.01), 'one cent is valid');
        System.assertEquals(true, PaymentValidator.isValid(1000), 'large amount is valid');
    }

    @isTest
    static void checksSupportedMethods() {
        System.assertEquals(true, PaymentValidator.isSupportedMethod('Card'), 'Card supported');
        System.assertEquals(false, PaymentValidator.isSupportedMethod('Crypto'), 'Crypto not supported');
    }
}

const crypto = require('crypto');
const {
    promisify
} = require('util');
const jwt = require('jsonwebtoken');
const User = require('./../models/userModel');
const catchAsync = require('./../utils/catchAsync');
const AppError = require('../utils/appError');
const sendEmail = require('../utils/email');

const signToken = id => {
    return jwt.sign({
        id
    }, process.env.JWT_SECERT, {
        expiresIn: process.env.JWT_EXPIRES_IN
    });
}

const createAndSendToken = (user, statusCode, res) => {
    const token = signToken(user._id);
    const cookiesOptions = {
        expires: new Date(Date.now() + process.env.JWT_COOKIE_EXPIRES_IN * 24 * 60 * 60 * 1000),
        httpOnly: true
    };

    if(process.env.NODE_ENV === 'production') cookiesOptions.secure = true;

    res.cookie('jwt', token, cookiesOptions)

    // Remove password from output
    user.password = undefined;

    res.status(statusCode).json({
        status: 'success',
        token,
        data: {
            user
        }
    });
}

exports.signup = catchAsync(async (req, res, next) => {
    const newUser = await User.create(req.body);

    createAndSendToken(newUser, 201, res);
});

exports.login = catchAsync(async (req, res, next) => {
    const {
        email,
        password
    } = req.body;
    // Check if email and password exist
    if (!email || !password) {
        return next(new AppError('Please provide email and password!', 400));
    }
    // Check if user exists && password is correct
    const user = await User.findOne({
        email: email
    }).select('+password');

    if (!user || !(await user.correctPassword(password, user.password))) {
        return next(new AppError('Incorrect email or password', 401));
    }
    // If everything is okay, send token to client
    createAndSendToken(user, 200, res);
});

exports.protect = catchAsync(async (req, res, next) => {
    let token;
    if (
        req.headers.authorization && req.headers.authorization.startsWith('Bearer')
    ) {
        token = req.headers.authorization.split(' ')[1];
    }
    if (!token) {
        return next(new AppError('You are not logged in! Please log in to get access'), 401)
    };

    //2) Verification token
    const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECERT)
    //3) Check if user still exists
    const currentUser = await User.findById(decoded.id);
    if (!currentUser) {
        return next(new AppError('The user beloging to this token does no longer exist', 401));
    }
    //4) Check if user changed password after the token was issued
    if (currentUser.changedPasswordAfter(decoded.iat)) {
        return next(new AppError('User recently changed password! Please log in again.', 401))
    }
    //Grant access to protected route
    req.user = currentUser;
    next();
})
// access to role's parameters
exports.restrictTo = (...roles) => {
    return (req, res, next) => {
        // roles ['admin', 'lead-guide'] role="user"
        if (!roles.includes(req.user.role)) {
            return next(new AppError('You do not have permission to perform this action', 403));
        }
        next();
    }
}

exports.forgotPassword = catchAsync(async(req, res, next) => {
    // 1) Get user based on POSTed email
    const user = await User.findOne({ email: req.body.email})
    if(!user){
        return next(new AppError('There is no user with email address', 404))
    }
    // 2) Generate the random reset token
    const resetToken = user.createPasswordResetToken();
    // Because we didnt provide enough mandatory data so we need to set it false to save it
    await user.save({validateBeforeSave: false})
    // 3) Sent it to user's mail
    const resetURL = `${req.protocol}://${req.get('host')}/api/v1/users/resetPassword/${resetToken}`;

    const message = `Forgot your password? Submit a PATCH request with your new password and passwordConfirm to: ${resetURL}.\n
    If you didn't forget your password, please ignore this email!`;

    try {
        await sendEmail({
            email: user.email,
            subject: 'Your password reset token (valid for 10 minutes)',
            message
        });
    
        res.status(200).json({
            status: 'success',
            message: 'Token send to email!'
        })
    } catch(err) {
        console.log(err)
        user.passwordResetToken = undefined;
        user.passwordResetExpires = undefined;
        // Because we didnt provide enough mandatory data so we need to set it false to save it
        await user.save({validateBeforeSave: false})

        return next(new AppError('There was an error sending the email. Try again later!'), 500);
    }
});

exports.resetPassword =catchAsync(async (req, res, next) => {
    // 1) get user based on the token
    const hashedToken = crypto.createHash('sha256').update(req.params.token).digest('hex')

    const user = await User.findOne({ passwordResetToken: hashedToken, passwordResetExpires: {$gt: Date.now()} })
    // 2) If token has not expired, and there is user, set the new password
    if(!user){
        return next(new AppError('Token is invalid or has expired', 400));
    }
    user.password = req.body.password
    user.passwordConfirm = req.body.passwordConfirm
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save();
    // 3) Update changedPasswordAt property for the user 

    // 4) Log the user in, send JWT
    createAndSendToken(user, 201, res);
});

exports.updatePassword = catchAsync(async(req, res, next) => {
    // 1) Get user from the collection
    const user = await User.findById(req.user.id).select('+password');
    // 2) Check if POSTed current password is correct
    if (!(await user.correctPassword(req.body.passwordCurrent, user.password))) {
        return next(new AppError('Your current password is wrong.', 401));
    }

    // 3) If so, update password
    user.password = req.body.password;
    user.passwordConfirm = req.body.passwordConfirm;
    await user.save();
    // User.findByIdAndUpdate will NOT work as intended!
    // 4) Log user in, send JWT
    createAndSendToken(user, 201, res);
});